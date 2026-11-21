-- =====================================================================
-- 003: open_url = halaman DETAIL dulu, baru form pendaftaran
--   open_url = official_url (web/IG/TikTok/FB resmi) → source_url (halaman info) → registration_url
--   registration_url tetap dikembalikan untuk tombol "Daftar" terpisah.
-- Jalankan di Supabase SQL Editor setelah 002. Aman dijalankan ulang.
-- =====================================================================

-- Data dari sumber yang sudah dibuang (agen konsultan, link "daftar" = form konsultasi)
delete from opportunities where source_url like 'https://www.schoters.com/%';

-- Evaluasi ulang semua data dengan filter baru (siswa sekolah, duplikat, link resmi)
update opportunities set content_hash = 'reprocess';

drop function if exists get_feed(opp_category, int, int, uuid);

create or replace function get_feed(
  p_category opp_category default null,
  p_limit    int default 28,
  p_offset   int default 0,
  p_user     uuid default auth.uid()
)
returns table (
  id               uuid,
  title            text,
  category         opp_category,
  organizer        text,
  deadline         date,
  domains          text[],
  tags             text[],
  summary          text,
  registration_url text,
  official_url     text,
  source_url       text,
  open_url         text,
  match_score      numeric,
  match_reasons    text[],
  pool             text,
  bookmarked       boolean
)
language sql stable
set search_path = public, extensions
as $$
with u as (
  select p.*,
         array(select distinct x from unnest(p.interests || p.cv_domains) x) as udom
  from profiles p
  where p.id = p_user
    and (auth.uid() = p_user or auth.role() = 'service_role')
),
base as (
  select o.*,
    coalesce(1 - (o.embedding <=> u.embedding), 0)::numeric as vec,
    array(select unnest(o.domains) intersect select unnest(u.udom))     as dom_hit,
    array(select unnest(o.tags)    intersect select unnest(u.cv_skills)) as skill_hit
  from opportunities o
  cross join u
  where o.status = 'active'
    and (o.deadline is null or o.deadline >= current_date)
    and (p_category is null or o.category = p_category)
    and (cardinality(o.eligible_levels) = 0 or u.level = any (o.eligible_levels))
    and (
      cardinality(o.eligible_majors) = 0
      or o.is_general
      or exists (
        select 1 from unnest(o.eligible_majors) m
        where u.major ilike '%' || m || '%' or m ilike '%' || u.major || '%'
      )
    )
),
scored as (
  select b.*,
    round(
        0.45 * least(greatest((b.vec - 0.55) / 0.25, 0), 1)
      + 0.35 * coalesce(cardinality(b.dom_hit)::numeric / nullif(cardinality(b.domains), 0), 0)
      + 0.15 * cardinality(b.skill_hit)::numeric / greatest(cardinality(b.tags), 1)
      + case when b.deadline <= current_date + 14 then 0.05 else 0 end
    , 3) as score,
    case
      when cardinality(b.dom_hit) > 0 or (b.vec >= 0.67 and not b.is_general) then 'A'
      when b.is_general then 'B'
    end as pool_name
  from base b
),
ranked as (
  select s.*,
    row_number() over (
      partition by s.pool_name
      order by
        case when s.pool_name = 'A' then s.score end desc nulls last,
        case when s.pool_name = 'B' then s.deadline end asc nulls last,
        s.updated_at desc
    ) as rn
  from scored s
  where s.pool_name is not null
)
select
  r.id, r.title, r.category, r.organizer, r.deadline, r.domains, r.tags,
  r.summary, r.registration_url, r.official_url, r.source_url,
  coalesce(r.official_url, r.source_url, r.registration_url),
  r.score,
  (select array_agg(d.label) from domains d where d.slug = any (r.dom_hit)) || r.skill_hit,
  r.pool_name,
  exists (select 1 from bookmarks bm where bm.user_id = p_user and bm.opportunity_id = r.id)
from ranked r
order by
  case when r.pool_name = 'A' then (r.rn - 1) * 7.0 / 6 else r.rn * 7 - 0.5 end,
  r.score desc
limit p_limit offset p_offset;
$$;

grant execute on function get_feed(opp_category, int, int, uuid) to authenticated, service_role;

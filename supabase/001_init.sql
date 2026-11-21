-- =====================================================================
-- Platform Agregator Peluang Mahasiswa — skema awal
-- Jalankan sekali di Supabase Dashboard → SQL Editor → New query → Run.
-- Aman dijalankan ulang (idempotent sebisa mungkin).
-- SETELAH file ini, jalankan juga 002_official_url.sql (versi get_feed terbaru ada di sana).
-- =====================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------- Enum ----------
do $$ begin
  create type opp_category as enum ('lomba', 'magang', 'beasiswa');
exception when duplicate_object then null; end $$;

-- ---------- Taxonomy bidang (harus sama dengan DOMAINS di lib/extract.js) ----------
create table if not exists domains (
  slug  text primary key,
  label text not null
);

insert into domains (slug, label) values
  ('it',               'IT & Teknologi'),
  ('data_ai',          'Data & AI'),
  ('bisnis',           'Bisnis & Manajemen'),
  ('ekonomi',          'Ekonomi & Keuangan'),
  ('hukum',            'Hukum'),
  ('kesehatan',        'Kesehatan & Kedokteran'),
  ('teknik',           'Teknik & Rekayasa'),
  ('sains',            'Sains (MIPA)'),
  ('desain',           'Desain & Kreatif'),
  ('sosial_humaniora', 'Sosial & Humaniora'),
  ('pendidikan',       'Pendidikan'),
  ('pertanian',        'Pertanian & Lingkungan'),
  ('komunikasi',       'Komunikasi & Media'),
  ('umum',             'Umum / Semua Bidang')
on conflict (slug) do update set label = excluded.label;

-- ---------- Peluang hasil scraping ----------
create table if not exists opportunities (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  category         opp_category not null,
  organizer        text,
  deadline         date,
  domains          text[] not null default '{}',
  tags             text[] not null default '{}',
  eligible_levels  text[] not null default '{}',  -- kosong = semua jenjang
  eligible_majors  text[] not null default '{}',  -- kosong = semua jurusan
  is_general       boolean not null default false,
  requirements     text[] not null default '{}',
  summary          text,
  registration_url text,
  source_url       text not null unique,
  content_hash     text not null,
  embedding        vector(1024),                  -- gemini-embedding-001, outputDimensionality 1024
  status           text not null default 'active' check (status in ('active', 'expired')),
  scraped_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists opportunities_embedding_idx
  on opportunities using hnsw (embedding vector_cosine_ops);
create index if not exists opportunities_domains_idx
  on opportunities using gin (domains);
create index if not exists opportunities_feed_idx
  on opportunities (category, status, deadline);

-- ---------- Profil mahasiswa ----------
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  full_name   text not null,
  level       text not null check (level in ('D3', 'D4', 'S1', 'S2', 'S3')),
  major       text not null,
  interests   text[] not null default '{}',   -- slug dari tabel domains
  cv_path     text,                           -- path di bucket 'cv': <user_id>/cv.pdf
  cv_skills   text[] not null default '{}',
  cv_domains  text[] not null default '{}',
  cv_summary  text,
  embedding   vector(1024),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- Bookmark & interaksi ----------
create table if not exists bookmarks (
  user_id        uuid not null references profiles on delete cascade,
  opportunity_id uuid not null references opportunities on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);

create table if not exists interactions (
  id             bigserial primary key,
  user_id        uuid not null references profiles on delete cascade,
  opportunity_id uuid not null references opportunities on delete cascade,
  kind           text not null check (kind in ('view', 'click', 'bookmark', 'dismiss')),
  created_at     timestamptz not null default now()
);
create index if not exists interactions_user_idx on interactions (user_id, created_at desc);

-- ---------- Log tiap siklus scraping ----------
create table if not exists scrape_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  pages       int not null default 0,
  extracted   int not null default 0,
  skipped     int not null default 0,
  errors      int not null default 0,
  note        text
);

-- ---------- updated_at otomatis ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_opportunities_updated on opportunities;
create trigger trg_opportunities_updated before update on opportunities
  for each row execute function set_updated_at();

drop trigger if exists trg_profiles_updated on profiles;
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

-- =====================================================================
-- Row Level Security
-- (service_role key dari scraper-service otomatis melewati RLS)
-- =====================================================================
alter table domains       enable row level security;
alter table opportunities enable row level security;
alter table profiles      enable row level security;
alter table bookmarks     enable row level security;
alter table interactions  enable row level security;
alter table scrape_runs   enable row level security;

drop policy if exists "domains public read" on domains;
create policy "domains public read" on domains for select using (true);

drop policy if exists "opportunities public read" on opportunities;
create policy "opportunities public read" on opportunities for select using (true);

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for all
  using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own bookmarks" on bookmarks;
create policy "own bookmarks" on bookmarks for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own interactions" on interactions;
create policy "own interactions" on interactions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- scrape_runs: tanpa policy = hanya service_role yang bisa akses

-- =====================================================================
-- Storage: bucket privat untuk CV (PDF, maks 5 MB)
-- File disimpan di <user_id>/<nama>.pdf
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cv', 'cv', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "cv owner read"   on storage.objects;
drop policy if exists "cv owner write"  on storage.objects;
drop policy if exists "cv owner update" on storage.objects;
drop policy if exists "cv owner delete" on storage.objects;

create policy "cv owner read" on storage.objects for select
  using (bucket_id = 'cv' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv owner write" on storage.objects for insert
  with check (bucket_id = 'cv' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv owner update" on storage.objects for update
  using (bucket_id = 'cv' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "cv owner delete" on storage.objects for delete
  using (bucket_id = 'cv' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- Feed rekomendasi hybrid
--   skor  = 0.45·vektor_norm + 0.35·irisan bidang + 0.15·irisan skill + 0.05 (deadline ≤ 14 hari)
--   vektor_norm = (cosine − 0.55) / 0.25, dibatasi 0..1
--     (dikalibrasi untuk gemini-embedding-001: tidak relevan ≈ 0.57, relevan ≈ 0.68–0.80)
--   Pool A (relevan)    : irisan bidang > 0, atau cosine ≥ 0.67 untuk peluang yang tidak umum
--   Pool B (eksplorasi) : is_general dan bukan pool A
--   Interleave 6 A : 1 B (≈ 86% / 14%)
-- Dipanggil dari frontend: supabase.rpc('get_feed', { p_category: 'lomba' })
-- =====================================================================
drop function if exists get_feed(uuid, opp_category, int, int);
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
  source_url       text,
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
    -- user hanya boleh mengambil feed miliknya sendiri
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
      -- peluang umum tanpa irisan bidang selalu masuk eksplorasi
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
  r.summary, r.registration_url, r.source_url,
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

-- Tandai peluang kedaluwarsa (dipanggil scraper tiap siklus)
create or replace function expire_opportunities() returns int
language sql as $$
  with x as (
    update opportunities set status = 'expired'
    where status = 'active' and deadline < current_date
    returning 1
  )
  select count(*)::int from x;
$$;
revoke execute on function expire_opportunities() from public, anon, authenticated;

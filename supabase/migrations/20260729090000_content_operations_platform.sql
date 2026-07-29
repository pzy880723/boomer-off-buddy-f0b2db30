create extension if not exists pgcrypto;

do $$ begin
  create type public.editorial_content_type as enum (
    'article', 'horizontal_video', 'vertical_video'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.editorial_content_status as enum (
    'draft', 'pending_review', 'scheduled', 'published', 'archived'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.editorial_contents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  type public.editorial_content_type not null,
  status public.editorial_content_status not null default 'draft',
  title text not null,
  summary text not null,
  body text,
  cover_url text,
  video_url text,
  aspect_ratio numeric(8, 5) not null default 1.33333 check (aspect_ratio > 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  source jsonb not null default '{}'::jsonb,
  channel_ids text[] not null default '{}',
  keywords text[] not null default '{}',
  related_product_ids uuid[] not null default '{}',
  related_knowledge_ids uuid[] not null default '{}',
  scheduled_at timestamptz,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editorial_article_body check (type <> 'article' or nullif(trim(body), '') is not null),
  constraint editorial_video_url check (type = 'article' or nullif(trim(video_url), '') is not null)
);

create table if not exists public.editorial_content_channels (
  id text primary key,
  name text not null,
  group_name text not null default '内容主题',
  sort_order integer not null default 0,
  is_active boolean not null default true
);

create table if not exists public.editorial_content_relations (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.editorial_contents(id) on delete cascade,
  entity_type text not null check (
    entity_type in ('primary_category', 'brand', 'facet', 'product', 'official_knowledge')
  ),
  entity_key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (content_id, entity_type, entity_key)
);

create table if not exists public.editorial_content_engagement (
  content_id uuid primary key references public.editorial_contents(id) on delete cascade,
  like_count integer not null default 0 check (like_count >= 0),
  comment_count integer not null default 0 check (comment_count >= 0),
  share_count integer not null default 0 check (share_count >= 0),
  bookmark_count integer not null default 0 check (bookmark_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.editorial_content_comments (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.editorial_contents(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  author_name text not null default 'BOOMER 用户',
  body text not null check (length(trim(body)) between 1 and 500),
  status text not null default 'pending_review' check (
    status in ('pending_review', 'published', 'rejected')
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.editorial_content_user_actions (
  content_id uuid not null references public.editorial_contents(id) on delete cascade,
  user_key text not null,
  action text not null check (action in ('like', 'bookmark')),
  created_at timestamptz not null default now(),
  primary key (content_id, user_key, action)
);

create table if not exists public.official_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  type text not null check (
    type in (
      'brand', 'category', 'ip', 'character_series', 'era_style',
      'material_craft', 'origin_kiln', 'collection_care'
    )
  ),
  status public.editorial_content_status not null default 'draft',
  title text not null,
  summary text not null,
  story text not null,
  evidence text[] not null default '{}',
  care_advice text[] not null default '{}',
  cover_url text,
  keywords text[] not null default '{}',
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.official_knowledge_relations (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.official_knowledge_entries(id) on delete cascade,
  is_primary boolean not null default false,
  entity_type text not null check (
    entity_type in ('primary_category', 'brand', 'facet', 'product')
  ),
  entity_key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (knowledge_id, entity_type, entity_key)
);

create or replace function public.tg_editorial_content_engagement_init()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.editorial_content_engagement (content_id)
  values (new.id)
  on conflict (content_id) do nothing;
  return new;
end;
$$;

drop trigger if exists editorial_content_engagement_init on public.editorial_contents;
create trigger editorial_content_engagement_init
  after insert on public.editorial_contents
  for each row execute function public.tg_editorial_content_engagement_init();

create or replace function public.tg_editorial_content_action_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content_id uuid;
  v_action text;
  v_delta integer;
begin
  if tg_op = 'DELETE' then
    v_content_id := old.content_id;
    v_action := old.action;
    v_delta := -1;
  else
    v_content_id := new.content_id;
    v_action := new.action;
    v_delta := 1;
  end if;

  insert into public.editorial_content_engagement (content_id)
  values (v_content_id)
  on conflict (content_id) do nothing;

  update public.editorial_content_engagement
  set
    like_count = greatest(
      0,
      like_count + case when v_action = 'like' then v_delta else 0 end
    ),
    bookmark_count = greatest(
      0,
      bookmark_count + case when v_action = 'bookmark' then v_delta else 0 end
    ),
    updated_at = now()
  where content_id = v_content_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists editorial_content_action_count
  on public.editorial_content_user_actions;
create trigger editorial_content_action_count
  after insert or delete on public.editorial_content_user_actions
  for each row execute function public.tg_editorial_content_action_count();

create or replace function public.tg_editorial_content_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content_id uuid;
begin
  if tg_op = 'DELETE' then
    v_content_id := old.content_id;
  else
    v_content_id := new.content_id;
  end if;

  insert into public.editorial_content_engagement (content_id)
  values (v_content_id)
  on conflict (content_id) do nothing;

  update public.editorial_content_engagement
  set
    comment_count = (
      select count(*)::integer
      from public.editorial_content_comments
      where content_id = v_content_id
        and status = 'published'
    ),
    updated_at = now()
  where content_id = v_content_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists editorial_content_comment_count
  on public.editorial_content_comments;
create trigger editorial_content_comment_count
  after insert or update of status or delete on public.editorial_content_comments
  for each row execute function public.tg_editorial_content_comment_count();

create or replace function public.increment_editorial_content_share(p_content_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.editorial_content_engagement (content_id, share_count)
  values (p_content_id, 1)
  on conflict (content_id) do update
  set
    share_count = editorial_content_engagement.share_count + 1,
    updated_at = now()
  returning share_count into v_count;

  return v_count;
end;
$$;

revoke all on function public.tg_editorial_content_engagement_init() from public;
revoke all on function public.tg_editorial_content_action_count() from public;
revoke all on function public.tg_editorial_content_comment_count() from public;
revoke all on function public.increment_editorial_content_share(uuid)
  from public, anon, authenticated;
grant execute on function public.increment_editorial_content_share(uuid) to service_role;

insert into public.editorial_content_engagement (content_id)
select id from public.editorial_contents
on conflict (content_id) do nothing;

create index if not exists editorial_contents_public_feed_idx
  on public.editorial_contents (status, published_at desc);
create index if not exists editorial_contents_type_idx
  on public.editorial_contents (type, status, published_at desc);
create index if not exists editorial_contents_channels_gin
  on public.editorial_contents using gin (channel_ids);
create index if not exists editorial_contents_keywords_gin
  on public.editorial_contents using gin (keywords);
create index if not exists editorial_relations_entity_idx
  on public.editorial_content_relations (entity_type, entity_key);
create index if not exists official_knowledge_public_idx
  on public.official_knowledge_entries (status, published_at desc);
create index if not exists official_knowledge_relations_entity_idx
  on public.official_knowledge_relations (entity_type, entity_key);

alter table public.editorial_contents enable row level security;
alter table public.editorial_content_channels enable row level security;
alter table public.editorial_content_relations enable row level security;
alter table public.editorial_content_engagement enable row level security;
alter table public.editorial_content_comments enable row level security;
alter table public.editorial_content_user_actions enable row level security;
alter table public.official_knowledge_entries enable row level security;
alter table public.official_knowledge_relations enable row level security;

drop policy if exists "Public reads published editorial content" on public.editorial_contents;
create policy "Public reads published editorial content"
  on public.editorial_contents for select
  using (status = 'published' and published_at <= now());

drop policy if exists "Public reads active editorial channels" on public.editorial_content_channels;
create policy "Public reads active editorial channels"
  on public.editorial_content_channels for select using (is_active);

drop policy if exists "Public reads published editorial relations" on public.editorial_content_relations;
create policy "Public reads published editorial relations"
  on public.editorial_content_relations for select
  using (
    exists (
      select 1 from public.editorial_contents c
      where c.id = content_id and c.status = 'published' and c.published_at <= now()
    )
  );

drop policy if exists "Public reads editorial engagement" on public.editorial_content_engagement;
create policy "Public reads editorial engagement"
  on public.editorial_content_engagement for select using (true);

drop policy if exists "Public reads approved comments" on public.editorial_content_comments;
create policy "Public reads approved comments"
  on public.editorial_content_comments for select using (status = 'published');

drop policy if exists "Public reads published official knowledge" on public.official_knowledge_entries;
create policy "Public reads published official knowledge"
  on public.official_knowledge_entries for select
  using (status = 'published' and published_at <= now());

drop policy if exists "Public reads published official knowledge relations" on public.official_knowledge_relations;
create policy "Public reads published official knowledge relations"
  on public.official_knowledge_relations for select
  using (
    exists (
      select 1 from public.official_knowledge_entries k
      where k.id = knowledge_id and k.status = 'published' and k.published_at <= now()
    )
  );

insert into public.editorial_content_channels (id, name, group_name, sort_order)
values
  ('recommended', '推荐', '固定', 0),
  ('porcelain', '瓷器', '热门品类', 10),
  ('toys', '玩具', '热门品类', 20),
  ('vinyl', '黑胶', '热门品类', 30),
  ('digital', '数码', '热门品类', 40),
  ('home', '家居', '热门品类', 50),
  ('paper', '纸品', '热门品类', 60),
  ('fashion', '服饰', '热门品类', 70),
  ('brand', '品牌档案', '内容主题', 100),
  ('collection', '全球馆藏', '内容主题', 110),
  ('design', '设计史', '内容主题', 120),
  ('store', '门店上新', '内容主题', 130),
  ('guide', '收藏指南', '内容主题', 140)
on conflict (id) do update set
  name = excluded.name,
  group_name = excluded.group_name,
  sort_order = excluded.sort_order;

-- MemoPad (voice memo affirmations) · runs inside the existing Progress Pad Supabase project
-- Adds only new memopad_ tables and one new storage bucket. Nothing in Progress Pad is changed.
-- Same login: anyone with a Progress Pad account can sign in to MemoPad (auth.users is shared).

-- 1. Memos (one row per affirmation track; transcript + chapters kept as JSON)
create table if not exists public.memopad_memos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null,
  description  text,
  category     text,                         -- e.g. Confidence, Tasks, Mornings
  audio_path   text not null,                -- path inside the memopad-audio bucket: {user_id}/{memo_id}.mp3
  duration_s   numeric,
  peaks        jsonb,                        -- waveform bars (20 per second), so the waveform shows instantly
  words        jsonb not null default '[]',  -- [{text,start,end}]
  chapters     jsonb not null default '[]',  -- [{t,title}]
  is_shared    boolean not null default false, -- true = shows in the shared library ("the MemoPad library")
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists memopad_memos_user_idx on public.memopad_memos(user_id, created_at desc);
create index if not exists memopad_memos_shared_idx on public.memopad_memos(is_shared) where is_shared;

alter table public.memopad_memos enable row level security;

create policy "memopad: read own or shared" on public.memopad_memos
  for select to authenticated using (auth.uid() = user_id or is_shared);
create policy "memopad: insert own" on public.memopad_memos
  for insert to authenticated with check (auth.uid() = user_id);
create policy "memopad: update own" on public.memopad_memos
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "memopad: delete own" on public.memopad_memos
  for delete to authenticated using (auth.uid() = user_id);

create or replace function public.memopad_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists memopad_memos_touch on public.memopad_memos;
create trigger memopad_memos_touch before update on public.memopad_memos for each row execute function public.memopad_touch();

-- 2. Private audio bucket (free plan: 50 MB per file, 1 GB total storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('memopad-audio', 'memopad-audio', false, 52428800,
        array['audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/x-wav','audio/aac','audio/ogg','audio/webm'])
on conflict (id) do nothing;

-- Files live in a folder named after the owner's user id
create policy "memopad-audio: owner read" on storage.objects for select to authenticated
  using (bucket_id = 'memopad-audio' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.memopad_memos m where m.audio_path = storage.objects.name and m.is_shared)
  ));
create policy "memopad-audio: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "memopad-audio: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "memopad-audio: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = auth.uid()::text);

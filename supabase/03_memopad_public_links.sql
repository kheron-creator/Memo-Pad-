-- MemoPad: public no-sign-up listening links, chosen memo by memo (off by default). Approved by Kheron 2026-11-05.
-- Only touches MemoPad's own table and bucket. Nothing in Progress Pad is changed.
alter table public.memopad_memos add column if not exists is_public boolean not null default false;
-- signed-out visitors may read only these columns (not user_id or the pasted script), and only of public memos
grant select (id, title, category, duration_s, peaks, words, chapters, audio_path, is_public, created_at) on public.memopad_memos to anon;
drop policy if exists "memopad: anyone reads public" on public.memopad_memos;
create policy "memopad: anyone reads public" on public.memopad_memos for select to anon, authenticated using (is_public);
drop policy if exists "memopad-audio: anyone reads public" on storage.objects;
create policy "memopad-audio: anyone reads public" on storage.objects for select to anon, authenticated
  using (bucket_id = 'memopad-audio' and exists (select 1 from public.memopad_memos m where m.audio_path = storage.objects.name and m.is_public));

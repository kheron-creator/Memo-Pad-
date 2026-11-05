-- MemoPad: faster row-level security (fixes the Supabase "auth_rls_initplan" advisor warnings for memopad_ only).
-- Only touches MemoPad's own policies. Nothing in Progress Pad is changed.
alter policy "memopad: read own or shared" on public.memopad_memos using ((select auth.uid()) = user_id or is_shared);
alter policy "memopad: insert own" on public.memopad_memos with check ((select auth.uid()) = user_id);
alter policy "memopad: update own" on public.memopad_memos using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "memopad: delete own" on public.memopad_memos using ((select auth.uid()) = user_id);
alter policy "memopad-audio: owner read" on storage.objects using (bucket_id = 'memopad-audio' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (select 1 from public.memopad_memos m where m.audio_path = storage.objects.name and m.is_shared)));
alter policy "memopad-audio: owner upload" on storage.objects with check (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
alter policy "memopad-audio: owner update" on storage.objects using (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
alter policy "memopad-audio: owner delete" on storage.objects using (bucket_id = 'memopad-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

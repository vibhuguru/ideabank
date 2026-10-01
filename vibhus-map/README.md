# Vibhu's Map of Global Health

A goofy world map of public health news, history and medical art. Let's learn!

## Files
- `index.html` – the whole site
- `data/stories.json` – current news pins (updated weekly)
- `data/history.json` – History mode events
- `data/art.json` – Medical art gallery
- `data/flags.json` – country flags

## Turn on GitHub Pages
Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save.
The site appears at `https://vibhuguru.github.io/<repo-name>/` within a minute or two.

## Hearts (Supabase)
1. In Supabase: Authentication → Sign In / Providers → turn on **Allow anonymous sign-ins**.
2. SQL Editor → New query → paste and run:

```sql
create table if not exists public.hearts (
  story_id   text not null,
  voter      uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (story_id, voter)
);
alter table public.hearts enable row level security;
create policy "anyone can read hearts"  on public.hearts for select using (true);
create policy "add your own heart"      on public.hearts for insert to authenticated with check (voter = auth.uid());
create policy "remove your own heart"   on public.hearts for delete to authenticated using (voter = auth.uid());
alter publication supabase_realtime add table public.hearts;
```

3. Paste the project's anon public (or publishable) key into `supabaseKey` near the top of `index.html`.

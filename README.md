# Ziksatech Ops Center

Internal operations platform for Ziksatech LLC — SAP consulting, staffing, and technology.

**Version:** 1.7.1  
**Stack:** React 18 + Vite + Vercel + Supabase (optional)

---

## Modules

37 modules across 6 domains: Dashboard, Sales/CRM, Delivery/Projects, Hiring/HR, Finance, Compliance.

## Quick Deploy (Vercel)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → Import Project → select this repo
3. Vercel auto-detects Vite — click **Deploy**
4. Done. Your app is live at `https://your-project.vercel.app`

## Multi-User (Supabase)

For shared data across team members:

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Run this SQL in the Supabase SQL editor:

```sql
create table ops_store (
  key        text primary key,
  value      text not null,
  updated_at timestamptz default now()
);
alter publication supabase_realtime add table ops_store;
create policy "team access" on ops_store
  for all using (true) with check (true);
alter table ops_store enable row level security;
```

3. In Vercel project settings → Environment Variables, add:
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON` = your Supabase anon key

4. Redeploy — all team members now share the same data in real-time.

## Local Dev

```bash
npm install
npm run dev      # starts at http://localhost:5173
npm run build    # production build → dist/
npm run preview  # preview production build
```

## Files

```
├── src/
│   ├── App.jsx      # Full application (19,243 lines)
│   └── main.jsx     # React entry point
├── index.html       # HTML shell
├── vite.config.js   # Vite configuration
├── vercel.json      # Vercel deployment config
└── .env.example     # Environment variable template
```

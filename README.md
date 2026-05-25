# Conciliación

Sistema interno para conciliar movimientos de cartolas bancarias contra movimientos de Dynatech.

Único tipo de usuario: **gerencia**.

## Stack

- Next.js 14 (App Router) + TypeScript
- PostgreSQL + Prisma 5
- Tailwind CSS 3
- Auth: JWT (`jose`) en cookie HTTP-only + `bcryptjs`
- TanStack Query, Zod, Recharts

## Setup

```bash
npm install
cp .env.example .env
# Editar .env con DATABASE_URL, JWT_SECRET y datos del usuario seed
npx prisma generate
npx prisma db push
npm run db:seed
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000) e iniciar sesión con las credenciales del seed.

## Módulos

| Ruta | Módulo | Estado |
|------|--------|--------|
| `/dashboard` | Dashboard (estadísticas) | Placeholder |
| `/dashboard/conciliacion` | Conciliación cartolas ↔ Dynatech | Placeholder |
| `/dashboard/cartolas` | Movimientos de cartolas bancarias | Placeholder |
| `/dashboard/dynatech` | Movimientos crudos desde API Dynatech | Placeholder |

Las funcionalidades de cada módulo se irán definiendo iterativamente.

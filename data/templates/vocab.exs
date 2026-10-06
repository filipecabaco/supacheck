defmodule Tpl.Vocab do
  @moduledoc """
  Shared vocabulary for template rendering: tables (resources) and framework wrappers.

  Resources marked `split: :test` never appear in training data, so the test split
  measures generalisation to unseen table names and column sets.
  """

  def resources do
    [
      %{table: "orders", noun: "order", plural: "orders", owner: "user_id", cols: "id, total, status", private: true, split: :train},
      %{table: "notes", noun: "note", plural: "notes", owner: "user_id", cols: "id, title, body", private: true, split: :train},
      %{table: "messages", noun: "message", plural: "messages", owner: "sender_id", cols: "id, body, created_at", private: true, split: :train},
      %{table: "payments", noun: "payment", plural: "payments", owner: "user_id", cols: "id, amount, card_last4", private: true, split: :train},
      %{table: "documents", noun: "document", plural: "documents", owner: "owner_id", cols: "id, name, storage_path", private: true, split: :train},
      %{table: "subscriptions", noun: "subscription", plural: "subscriptions", owner: "user_id", cols: "id, plan, status", private: true, split: :train},
      %{table: "journal_entries", noun: "entry", plural: "entries", owner: "author_id", cols: "id, mood, content", private: true, split: :train},
      %{table: "tasks", noun: "task", plural: "tasks", owner: "assignee_id", cols: "id, title, due_date", private: true, split: :train},
      %{table: "expenses", noun: "expense", plural: "expenses", owner: "user_id", cols: "id, amount, merchant", private: true, split: :train},
      %{table: "contacts", noun: "contact", plural: "contacts", owner: "owner_id", cols: "id, email, phone", private: true, split: :train},
      %{table: "workouts", noun: "workout", plural: "workouts", owner: "athlete_id", cols: "id, kind, duration", private: true, split: :train},
      %{table: "carts", noun: "cart", plural: "carts", owner: "shopper_id", cols: "id, items, total", private: true, split: :train},
      %{table: "chat_threads", noun: "thread", plural: "threads", owner: "created_by", cols: "id, topic, last_message", private: true, split: :train},
      %{table: "addresses", noun: "address", plural: "addresses", owner: "user_id", cols: "id, street, postcode", private: true, split: :train},
      %{table: "invoices", noun: "invoice", plural: "invoices", owner: "customer_id", cols: "id, amount_due, pdf_url", private: true, split: :test},
      %{table: "bookings", noun: "booking", plural: "bookings", owner: "guest_id", cols: "id, check_in, phone", private: true, split: :test},
      %{table: "health_records", noun: "record", plural: "records", owner: "patient_id", cols: "id, diagnosis, notes", private: true, split: :test}
    ]
  end

  def public_resources do
    [
      %{table: "products", noun: "product", plural: "products", cols: "id, name, price", split: :train},
      %{table: "categories", noun: "category", plural: "categories", cols: "id, name, slug", split: :train},
      %{table: "blog_posts", noun: "post", plural: "posts", cols: "id, title, published_at", split: :train},
      %{table: "plans", noun: "plan", plural: "plans", cols: "id, name, monthly_price", split: :train},
      %{table: "tags", noun: "tag", plural: "tags", cols: "id, label, color", split: :train},
      %{table: "countries", noun: "country", plural: "countries", cols: "id, name, iso_code", split: :train},
      %{table: "changelog_entries", noun: "release", plural: "releases", cols: "id, version, notes", split: :train},
      %{table: "announcements", noun: "announcement", plural: "announcements", cols: "id, title, body", split: :test},
      %{table: "faq_items", noun: "question", plural: "questions", cols: "id, question, answer", split: :test}
    ]
  end

  @doc "Server-side framework wrappers. `wrap.(body)` returns the full chunk."
  def frameworks(res) do
    p = res.plural

    [
      %{
        id: "next-route",
        context: "server (Next.js route handler)",
        file: "app/api/#{p}/route.ts",
        ok: fn e -> "return NextResponse.json(#{e})" end,
        deny: "return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })",
        input: "await request.json()",
        wrap: fn body ->
          """
          import { NextResponse } from 'next/server'
          import { createClient } from '@/lib/supabase/server'

          export async function POST(request: Request) {
            const supabase = await createClient()
          #{indent(body, 2)}
          }
          """
        end
      },
      %{
        id: "next-action",
        context: "server (Next.js server action)",
        file: "app/#{p}/actions.ts",
        ok: fn e -> "return #{e}" end,
        deny: "throw new Error('Unauthorized')",
        input: "Object.fromEntries(formData)",
        wrap: fn body ->
          """
          'use server'
          import { createClient } from '@/lib/supabase/server'

          export async function save#{camel(res.noun)}(formData: FormData) {
            const supabase = await createClient()
          #{indent(body, 2)}
          }
          """
        end
      },
      %{
        id: "sveltekit",
        context: "server (SvelteKit +page.server.ts)",
        file: "src/routes/#{p}/+page.server.ts",
        ok: fn e -> "return { result: #{e} }" end,
        deny: "redirect(303, '/login')",
        input: "Object.fromEntries(await request.formData())",
        wrap: fn body ->
          """
          import { redirect } from '@sveltejs/kit'
          import type { Actions } from './$types'

          export const actions: Actions = {
            default: async ({ request, locals: { supabase } }) => {
          #{indent(body, 4)}
            }
          }
          """
        end
      },
      %{
        id: "tanstack",
        context: "server (TanStack Start server function)",
        file: "src/server/#{p}.ts",
        ok: fn e -> "return #{e}" end,
        deny: "throw new Error('Unauthorized')",
        input: "data",
        wrap: fn body ->
          """
          import { createServerFn } from '@tanstack/react-start'
          import { getSupabaseServerClient } from '@/integrations/supabase/client.server'

          export const save#{camel(res.noun)} = createServerFn({ method: 'POST' })
            .validator((d: Record<string, unknown>) => d)
            .handler(async ({ data }) => {
              const supabase = getSupabaseServerClient()
          #{indent(body, 6)}
            })
          """
        end
      },
      %{
        id: "express",
        context: "server (Express route)",
        file: "server/routes/#{p}.ts",
        ok: fn e -> "return res.json(#{e})" end,
        deny: "return res.status(401).json({ error: 'Unauthorized' })",
        input: "req.body",
        wrap: fn body ->
          """
          import { Router } from 'express'
          import { createSupabaseServerClient } from '../lib/supabase'

          export const router = Router()

          router.post('/api/#{p}', async (req, res) => {
            const supabase = createSupabaseServerClient(req, res)
          #{indent(body, 2)}
          })
          """
        end
      },
      %{
        id: "remix",
        context: "server (Remix action)",
        file: "app/routes/#{p}.tsx",
        ok: fn e -> "return json(#{e})" end,
        deny: "throw redirect('/login')",
        input: "Object.fromEntries(await request.formData())",
        wrap: fn body ->
          """
          import { json, redirect, type ActionFunctionArgs } from '@remix-run/node'
          import { createSupabaseServerClient } from '~/lib/supabase.server'

          export async function action({ request }: ActionFunctionArgs) {
            const { supabase } = createSupabaseServerClient(request)
          #{indent(body, 2)}
          }
          """
        end
      }
    ]
  end

  def edge_wrap(body) do
    """
    import { createClient } from 'npm:@supabase/supabase-js@2'

    Deno.serve(async (req) => {
    #{indent(body, 2)}
    })
    """
  end

  def ts_header(context, file),
    do: "Language: TypeScript. Context: #{context}. File: #{file}"

  def sql_header(file, facts),
    do: "Language: SQL. Context: migration. File: #{file}. #{facts}"

  def indent(text, n) do
    pad = String.duplicate(" ", n)

    text
    |> String.trim_trailing()
    |> String.split("\n")
    |> Enum.map_join("\n", fn
      "" -> ""
      line -> pad <> line
    end)
  end

  def camel(s), do: s |> String.split("_") |> Enum.map_join(&String.capitalize/1)
end

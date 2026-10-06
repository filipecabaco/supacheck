defmodule Tpl.Sql do
  @moduledoc "Helpers shared by SQL templates."

  def table_ddl(r) do
    cols =
      r.cols
      |> String.split(", ")
      |> Enum.reject(&(&1 == "id"))
      |> Enum.map_join(",\n", &"  #{&1} text")

    owner = if Map.has_key?(r, :owner), do: "  #{r.owner} uuid not null references auth.users on delete cascade,\n", else: ""

    """
    create table public.#{r.table} (
      id bigint generated always as identity primary key,
    #{owner}#{cols}
    );
    alter table public.#{r.table} enable row level security;
    """
  end

  def file(r, _family) do
    # derived from the table only: positives and negatives share identical headers
    stamp = 20_260_901_120_000 + :erlang.phash2(r.table, 899_999)
    suffix = Enum.at(~w(init rls policies schema setup security), :erlang.phash2(r.table, 6))
    "supabase/migrations/#{stamp}_#{r.table}_#{suffix}.sql"
  end
end

defmodule Tpl.PolicyAuthenticatedNotAuthorized do
  @moduledoc "policy-authenticated-not-authorized: policy scoped only to 'signed in' on per-user data."
  import Tpl.Sql

  def rule, do: "policy-authenticated-not-authorized"
  def kind, do: :sql

  def render(r) do
    t = r.table

    [
      {"select-to-authenticated-true", 1,
       """
       #{table_ddl(r)}
       create policy "Authenticated users can read #{r.plural}" on public.#{t}
         for select to authenticated
         using (true);
       """},
      {"select-to-authenticated-true", 0,
       """
       #{table_ddl(r)}
       create policy "Users can read their own #{r.plural}" on public.#{t}
         for select to authenticated
         using ((select auth.uid()) = #{r.owner});
       """},
      {"role-authenticated", 1,
       """
       #{table_ddl(r)}
       create policy "Logged in users can update #{r.plural}" on public.#{t}
         for update
         using (auth.role() = 'authenticated');
       """},
      {"role-authenticated", 0,
       """
       #{table_ddl(r)}
       create policy "Owners can update #{r.plural}" on public.#{t}
         for update to authenticated
         using ((select auth.uid()) = #{r.owner})
         with check ((select auth.uid()) = #{r.owner});
       """},
      {"uid-not-null-all", 1,
       """
       #{table_ddl(r)}
       create policy "Signed in users manage #{r.plural}" on public.#{t}
         for all
         using (auth.uid() is not null)
         with check (auth.uid() is not null);
       """},
      {"uid-not-null-all", 0,
       """
       #{table_ddl(r)}
       create policy "Team members manage #{r.plural}" on public.#{t}
         for all to authenticated
         using (#{r.owner} in (select user_id from public.team_members where team_id in (select private.my_team_ids())))
         with check ((select auth.uid()) = #{r.owner});
       """},
      {"insert-any-owner", 1,
       """
       #{table_ddl(r)}
       create policy "Authenticated users can create #{r.plural}" on public.#{t}
         for insert to authenticated
         with check (auth.uid() is not null);
       """},
      {"insert-any-owner", 0,
       """
       #{table_ddl(r)}
       create policy "Users can create their own #{r.plural}" on public.#{t}
         for insert to authenticated
         with check ((select auth.uid()) = #{r.owner});
       """}
    ]
  end

  @doc "Intentionally shared tables: signed-in-only access is the design, label 0."
  def render_public(p) do
    [
      {"shared-table-authenticated", 0,
       """
       #{table_ddl(p)}
       -- every signed-in member of the workspace sees the same #{p.plural}
       create policy "Authenticated users can read #{p.plural}" on public.#{p.table}
         for select to authenticated
         using (true);
       """},
      {"shared-table-role", 0,
       """
       #{table_ddl(p)}
       create policy "Members can read #{p.plural}" on public.#{p.table}
         for select
         using (auth.role() = 'authenticated');
       """}
    ]
  end
end

defmodule Tpl.SelectTrueOnPrivateData do
  @moduledoc "select-true-on-private-data: always-true select on personal / per-user tables."
  import Tpl.Sql

  def rule, do: "select-true-on-private-data"
  def kind, do: :sql

  def render(r) do
    t = r.table

    [
      {"public-select-true", 1,
       """
       #{table_ddl(r)}
       create policy "Enable read access for all users" on public.#{t}
         for select
         using (true);
       """},
      {"anon-auth-true", 1,
       """
       #{table_ddl(r)}
       create policy "Public #{r.plural} are viewable by everyone" on public.#{t}
         for select to anon, authenticated
         using (true);
       """},
      {"one-equals-one", 1,
       """
       #{table_ddl(r)}
       create policy "Read #{r.plural}" on public.#{t}
         for select
         using (1 = 1);
       """},
      {"authenticated-true-select", 1,
       """
       #{table_ddl(r)}
       create policy "Signed in users can view #{r.plural}" on public.#{t}
         for select to authenticated
         using (true);
       """},
      {"owner-select", 0,
       """
       #{table_ddl(r)}
       create policy "Users can view their own #{r.plural}" on public.#{t}
         for select to authenticated
         using ((select auth.uid()) = #{r.owner});
       """},
      {"owner-or-shared", 0,
       """
       #{table_ddl(r)}
       create policy "Owners and collaborators can view #{r.plural}" on public.#{t}
         for select to authenticated
         using (
           (select auth.uid()) = #{r.owner}
           or exists (
             select 1 from public.#{r.noun}_shares s
             where s.#{r.noun}_id = #{t}.id and s.user_id = (select auth.uid())
           )
         );
       """}
    ]
  end

  def render_public(p) do
    [
      {"public-select-true", 0,
       """
       #{table_ddl(p)}
       create policy "Enable read access for all users" on public.#{p.table}
         for select
         using (true);
       """},
      {"anon-auth-true", 0,
       """
       #{table_ddl(p)}
       create policy "Public #{p.plural} are viewable by everyone" on public.#{p.table}
         for select to anon, authenticated
         using (true);
       """}
    ]
  end
end

defmodule Tpl.UserMetadataForAuthorization do
  @moduledoc "user-metadata-for-authorization: user-writable metadata deciding permissions."

  def rule, do: "user-metadata-for-authorization"
  def kind, do: :sql

  def render(r) do
    t = r.table

    [
      {"policy-role", 1,
       """
       create policy "Admins can read all #{r.plural}" on public.#{t}
         for select to authenticated
         using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'admin');
       """},
      {"policy-role", 0,
       """
       create policy "Admins can read all #{r.plural}" on public.#{t}
         for select to authenticated
         using (((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'admin');

       -- user_metadata only carries display preferences such as the theme
       """},
      {"trigger-copies-role", 1,
       """
       create or replace function public.handle_new_user()
       returns trigger
       language plpgsql
       security definer set search_path = ''
       as $$
       begin
         insert into public.profiles (id, full_name, role)
         values (
           new.id,
           new.raw_user_meta_data ->> 'full_name',
           coalesce(new.raw_user_meta_data ->> 'role', 'member')::public.app_role
         );
         return new;
       end;
       $$;
       """},
      {"trigger-copies-role", 0,
       """
       create or replace function public.handle_new_user()
       returns trigger
       language plpgsql
       security definer set search_path = ''
       as $$
       begin
         insert into public.profiles (id, full_name, avatar_url, role)
         values (
           new.id,
           new.raw_user_meta_data ->> 'full_name',
           new.raw_user_meta_data ->> 'avatar_url',
           'member'
         );
         return new;
       end;
       $$;
       """},
      {"helper-is-admin", 1,
       """
       create or replace function private.is_admin()
       returns boolean
       language sql stable
       security definer set search_path = ''
       as $$
         select coalesce((select raw_user_meta_data ->> 'is_admin' from auth.users where id = (select auth.uid()))::boolean, false);
       $$;

       create policy "Admins manage #{r.plural}" on public.#{t}
         for all to authenticated
         using ((select private.is_admin()));
       """},
      {"helper-is-admin", 0,
       """
       create or replace function private.is_admin()
       returns boolean
       language sql stable
       security definer set search_path = ''
       as $$
         select exists (select 1 from public.user_roles where user_id = (select auth.uid()) and role = 'admin');
       $$;

       create policy "Admins manage #{r.plural}" on public.#{t}
         for all to authenticated
         using ((select private.is_admin()));
       -- display name still comes from raw_user_meta_data in the profiles view
       """},
      {"plan-gate", 1,
       """
       create policy "Pro users can export #{r.plural}" on public.#{r.noun}_exports
         for insert to authenticated
         with check (
           (select auth.uid()) = user_id
           and (auth.jwt() -> 'user_metadata' ->> 'plan') = 'pro'
         );
       """},
      {"trigger-role-variable", 1,
       """
       create or replace function public.handle_new_user()
       returns trigger
       language plpgsql
       security definer set search_path = ''
       as $$
       declare
         v_role public.app_role;
       begin
         v_role := coalesce(nullif(new.raw_user_meta_data ->> 'account_type', '')::public.app_role, 'member');
         insert into public.profiles (id, role) values (new.id, v_role);
         return new;
       end;
       $$;
       """},
      {"trigger-role-variable", 0,
       """
       create or replace function public.handle_new_user()
       returns trigger
       language plpgsql
       security definer set search_path = ''
       as $$
       declare
         v_name text;
       begin
         v_name := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1));
         insert into public.profiles (id, display_name, role) values (new.id, v_name, 'member');
         return new;
       end;
       $$;
       """},
      {"display-view", 0,
       """
       create view public.#{r.noun}_authors with (security_invoker = true) as
         select t.id, t.#{r.owner}, u.raw_user_meta_data ->> 'full_name' as author_name
         from public.#{t} t
         join auth.users u on u.id = t.#{r.owner};
       """}
    ]
  end
end

defmodule Tpl.DefinerFunctionNoCallerCheck do
  @moduledoc "definer-function-no-caller-check: security definer trusting parameters."

  def rule, do: "definer-function-no-caller-check"
  def kind, do: :sql

  def render(r) do
    t = r.table

    [
      {"param-user-read", 1,
       """
       create or replace function public.get_user_#{r.plural}(p_user_id uuid)
       returns setof public.#{t}
       language sql
       security definer
       set search_path = ''
       as $$
         select * from public.#{t} where #{r.owner} = p_user_id;
       $$;
       """},
      {"param-user-read", 0,
       """
       create or replace function public.get_my_#{r.plural}()
       returns setof public.#{t}
       language sql
       security definer
       set search_path = ''
       as $$
         select * from public.#{t} where #{r.owner} = (select auth.uid());
       $$;
       """},
      {"delete-by-id", 1,
       """
       create or replace function public.delete_#{r.noun}(p_id bigint)
       returns void
       language plpgsql
       security definer
       set search_path = ''
       as $$
       begin
         delete from public.#{t} where id = p_id;
       end;
       $$;
       """},
      {"delete-by-id", 0,
       """
       create or replace function public.delete_#{r.noun}(p_id bigint)
       returns void
       language plpgsql
       security definer
       set search_path = ''
       as $$
       begin
         delete from public.#{t}
         where id = p_id and #{r.owner} = (select auth.uid());
         if not found then
           raise exception 'not allowed';
         end if;
       end;
       $$;
       """},
      {"set-role", 1,
       """
       create or replace function public.set_member_role(p_user uuid, p_role text)
       returns void
       language plpgsql
       security definer
       set search_path = ''
       as $$
       begin
         update public.profiles set role = p_role where id = p_user;
       end;
       $$;
       """},
      {"set-role", 0,
       """
       create or replace function public.set_member_role(p_user uuid, p_role text)
       returns void
       language plpgsql
       security definer
       set search_path = ''
       as $$
       begin
         if not exists (select 1 from public.user_roles where user_id = (select auth.uid()) and role = 'admin') then
           raise exception 'forbidden';
         end if;
         update public.profiles set role = p_role where id = p_user;
       end;
       $$;
       """},
      {"revoked-internal", 0,
       """
       create or replace function private.recalculate_#{r.noun}_totals(p_user_id uuid)
       returns void
       language sql
       security definer
       set search_path = ''
       as $$
         update public.#{t} set status = 'recalculated' where #{r.owner} = p_user_id;
       $$;

       revoke execute on function private.recalculate_#{r.noun}_totals(uuid) from public, anon, authenticated;
       """},
      {"transfer", 1,
       """
       create or replace function public.transfer_#{r.noun}(p_id bigint, p_new_owner uuid)
       returns void
       language sql
       security definer
       set search_path = ''
       as $$
         update public.#{t} set #{r.owner} = p_new_owner where id = p_id;
       $$;
       """},
      {"trigger-fn", 0,
       """
       create or replace function public.stamp_#{r.noun}_owner()
       returns trigger
       language plpgsql
       security definer
       set search_path = ''
       as $$
       begin
         new.#{r.owner} := (select auth.uid());
         return new;
       end;
       $$;

       create trigger stamp_owner before insert on public.#{t}
         for each row execute function public.stamp_#{r.noun}_owner();
       """}
    ]
  end
end

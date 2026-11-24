-- The agents' SQL tool logs in as radar_agent_reader on its own connection (SET ROLE under the owner's superuser
-- session was no boundary: set_config('role', ...) switched back). The login and its password (derived from the
-- owner's password) are set by the app on first use; here the role is pinned to the least privileges.
ALTER ROLE radar_agent_reader WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- No role memberships (a member could SET ROLE to it).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
           JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'radar_agent_reader' LOOP
    EXECUTE format('REVOKE %I FROM radar_agent_reader', r.rolname);
  END LOOP;
END $$;

-- Only what the pipeline agents need: the user's saved profile and the migration history are not theirs to read.
REVOKE ALL ON "operator_profile" FROM radar_agent_reader;
REVOKE ALL ON "_prisma_migrations" FROM radar_agent_reader;
REVOKE CREATE ON SCHEMA public FROM radar_agent_reader;

import { handleGetSession } from "../_shared/handlers.ts";
import { supabaseDeps } from "../_shared/supabase-deps.ts";

const deps = supabaseDeps();

Deno.serve((req) => handleGetSession(req, deps));

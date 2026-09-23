import { handleListFrames } from "../_shared/handlers.ts";
import { supabaseDeps } from "../_shared/supabase-deps.ts";

const deps = supabaseDeps();

Deno.serve((req) => handleListFrames(req, deps));

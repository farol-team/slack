import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "../../api/router";

/// The typed client every page calls the API through.
///
/// Its own module rather than an export beside `TRPCProvider`: a file that
/// exports a component and something else is a file Vite's fast refresh gives
/// up on, and the whole app reloading on every edit to a query is how a fast
/// feedback loop stops being fast.
export const trpc = createTRPCReact<AppRouter>();

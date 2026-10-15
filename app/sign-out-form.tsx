import { pageActor } from "@/access/session";
import { signOut } from "./sign-in/actions";

export async function SignOutForm() {
  const actor = await pageActor("transfer.dryRun");
  if (actor.role === "open") return null;
  return (
    <form action={signOut} className="sign-out">
      <button className="button-quiet" type="submit">
        Sign out
      </button>
    </form>
  );
}

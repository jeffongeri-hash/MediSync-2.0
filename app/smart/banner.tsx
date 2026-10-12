// Launch context shown on every page reached through a SMART launch: which server, which user, which patient.
import type { SmartSession } from "@/smart/session";

const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function LaunchBanner({ session, name }: { session: SmartSession; name: string | null }) {
  return (
    <aside className="launch-banner" aria-label="Launch context">
      <dl>
        <dt>Launched from</dt>
        <dd className="mono">{session.iss}</dd>
        <dt>Launch</dt>
        <dd>
          {session.launchType === "ehr" ? "EHR launch" : "Standalone launch"} ·{" "}
          {session.authorizedAt ? when(session.authorizedAt) : "not completed"}
        </dd>
        <dt>User</dt>
        <dd className="mono">{session.fhirUser ?? "not provided (no fhirUser claim)"}</dd>
        <dt>Patient</dt>
        <dd>
          {name ?? "unknown"} <span className="mono subtle">Patient/{session.fhirPatientId}</span>
          {session.encounterId ? (
            <span className="mono subtle"> · Encounter/{session.encounterId}</span>
          ) : null}
        </dd>
      </dl>
    </aside>
  );
}

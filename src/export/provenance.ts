// One FHIR Provenance per exported resource: who asserted it (the source system), who transmitted it (MediSync),
// and which received documents it came from (the primary row's source plus every linked cross-format duplicate).
import { profileUrl } from "@/export/us-core";

export type SourceRef = {
  format: string;
  sourceSystem: string;
  /** sha256 of the received document: stable across databases, unlike row ids. */
  sha256: string;
  resourceType: string;
  fhirId: string;
};

export const SOURCE_DOCUMENT_SYSTEM = "urn:medisync:source-document:sha256";
const PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const US_CORE_PARTICIPANT_TYPE =
  "http://hl7.org/fhir/us/core/CodeSystem/us-core-provenance-participant-type";

export function provenanceFor(targetFullUrl: string, recorded: string, sources: SourceRef[]) {
  const systems = [...new Set(sources.map((s) => s.sourceSystem))];
  return {
    resourceType: "Provenance" as const,
    meta: { profile: [profileUrl("us-core-provenance")] },
    target: [{ reference: targetFullUrl }],
    recorded,
    agent: [
      ...systems.map((s) => ({
        type: { coding: [{ system: PARTICIPANT_TYPE, code: "author", display: "Author" }] },
        who: { display: `Source system: ${s}` },
      })),
      {
        type: {
          coding: [
            { system: US_CORE_PARTICIPANT_TYPE, code: "transmitter", display: "Transmitter" },
          ],
        },
        who: { display: "MediSync transfer pipeline" },
      },
    ],
    entity: sources.map((s) => ({
      role: "source",
      what: {
        identifier: { system: SOURCE_DOCUMENT_SYSTEM, value: s.sha256 },
        display: `${s.format} ${s.resourceType}/${s.fhirId}`,
      },
    })),
  };
}

// The one registry of executable end-to-end cases. A case names the platforms
// it runs on; the runner supplies the transport and the report.
//
// `realCases` are a separate profile: they run only against a real provider and
// reuse the CONN and SESS behaviors that the mock suite already defines.

import { connectionCases } from "./connection.mjs";
import { errorsCases } from "./errors.mjs";
import { managementCases } from "./management.mjs";
import { runCases } from "./run.mjs";
import { securityCases } from "./security.mjs";
import { sessionsCases } from "./sessions.mjs";

export const cases = [
    ...connectionCases,
    ...sessionsCases,
    ...runCases,
    ...managementCases,
    ...errorsCases,
    ...securityCases,
];

export { realCases } from "./real.mjs";

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach } from "vitest";

// Testing Library unmounts whatever a test rendered, so that the next test
// starts with an empty document. It registers that itself only when the runner
// offers a global `afterEach`, which vitest does with `globals: true` - and this
// project's config keeps the globals off, so the cleanup is registered here.
// Without it, a query for what is absent finds what a test before it rendered.
afterEach(cleanup);

// Animations off, so a test asserts what a component does rather than how it
// got there. Without this, anything behind a presence boundary waits on an
// exit animation that this environment never runs to completion, and the
// arriving element is never mounted — so the test fails on choreography it was
// never about.
MotionGlobalConfig.skipAnimations = true;

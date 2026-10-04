import "@testing-library/jest-dom/vitest";
import { MotionGlobalConfig } from "motion/react";

// Animations off, so a test asserts what a component does rather than how it
// got there. Without this, anything behind a presence boundary waits on an
// exit animation that this environment never runs to completion, and the
// arriving element is never mounted — so the test fails on choreography it was
// never about.
MotionGlobalConfig.skipAnimations = true;

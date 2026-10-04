import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";
import { HostKeyPrompt } from "@/routes/connect/components/HostKeyPrompt";

/**
 * The host-key question in both of its shapes.
 *
 * A real window picks one by asking `useIsMobile`, which answers for the
 * machine rather than for the viewport — so a Storybook frame pins it and both
 * shapes are reviewable from one machine.
 */

const KEY = {
    host: "192.168.1.10",
    port: 22,
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:2a:b4:c1:88:9f:0e",
};

const meta = {
    title: "Connect/HostKeyPrompt",
    component: HostKeyPrompt,
    args: { presentedKey: KEY, onAnswer: () => undefined },
    parameters: {
        layout: "fullscreen",
        // The prompt is `fixed` against the viewport, so the frame has to be more than
        // a padded box for it to land at the bottom edge.
        decorators: [
            (Story: ComponentType) => (
                <div className="bg-surface flex h-svh items-center justify-center font-sans">
                    <p className="text-body-md text-muted-foreground">the workspace behind the scrim</p>
                    <Story />
                </div>
            ),
        ],
    },
} satisfies Meta<typeof HostKeyPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The sheet a thumb can reach, on a touch window. */
export const Sheet: Story = { args: { isMobile: true } };

/** The centred dialog a pointer gets, on a desktop window. */
export const Dialog: Story = { args: { isMobile: false } };

/** An RSA key is the same prompt with a longer name in it. */
export const Rsa: Story = {
    args: {
        isMobile: false,
        presentedKey: { ...KEY, algorithm: "rsa-sha2-512", fingerprint: "SHA256:9f3kQpL2xNvB7cYtR4mWdA8sH1jK6dE0uZ" },
    },
};

/** No question open: the machine says null, and nothing is drawn over the work. */
export const NoQuestion: Story = { args: { isMobile: false, presentedKey: null } };

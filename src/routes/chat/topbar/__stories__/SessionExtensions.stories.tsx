import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { idOf } from "@/lib/session";
import { useExtensionStore } from "@/lib/extension";
import { conversation } from "@/preview/fixtures";
import { SessionExtensions } from "@/routes/chat/topbar/SessionExtensions";

const CONVERSATION = conversation({ session: "main:1" });
const statuses = [
    { key: "pi-permission-system", text: "yolo" },
    { key: "ollama-usage", text: "Request in flight" },
];

/** Seeds the one store the bar reads, before the first frame draws it. */
function useSeededStore(): void {
    useState(() => {
        useExtensionStore.setState({
            statuses: { [idOf(CONVERSATION)]: statuses },
            dialogs: {},
            editors: {},
        });
    });
}

/**
 * The bar's extension key: the dot says a status exists, and a press opens the
 * list. The statuses are seeded where the store holds them.
 */
const meta = {
    title: "Chat/Extension status",
    component: SessionExtensions,
    parameters: { layout: "fullscreen" },
    decorators: [
        (Story) => {
            useSeededStore();
            return (
                <div className="flex justify-end bg-surface p-4 font-sans">
                    <Story />
                </div>
            );
        },
    ],
    args: { conversation: CONVERSATION },
} satisfies Meta<typeof SessionExtensions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A conversation with two status lines: the dot is on, and the dialog has their words. */
export const Reported: Story = {};

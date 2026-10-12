import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConnectionCard, type ConnectionCardProps, type ConnectionForm } from "@/routes/connect/components";

/** Each situation is reachable from props alone: the card holds no connection. */

const LOCAL: ConnectionForm = {
    transport: "local",
    auth: "password",
    address: "",
    password: "",
    privateKeyMaterial: "",
    passphrase: "",
};

const SSH_PASSWORD: ConnectionForm = {
    ...LOCAL,
    transport: "ssh",
    address: "pi@192.168.1.10:22",
};

const SSH_KEY: ConnectionForm = {
    ...LOCAL,
    transport: "ssh",
    auth: "key",
    address: "pi@192.168.1.10:22",
};

const SSH_KEY_PASTED: ConnectionForm = {
    ...SSH_KEY,
    privateKeyMaterial:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\nc2gtZWQyNTUxOQAAACB\n-----END OPENSSH PRIVATE KEY-----",
    passphrase: "correct horse",
};

/** What every frame starts with; a story overrides what its situation changes.
 *
 *  A failed dial is not part of the card: it lands in the screen's toast stack,
 *  where every failure of this app lands. */
const BASE: ConnectionCardProps = {
    form: LOCAL,
    connecting: false,
    canConnect: true,
    missing: null,
    onChange: () => undefined,
    onConnect: () => undefined,
    onPickKey: () => undefined,
};

const meta = {
    title: "Connect/ConnectionCard",
    component: ConnectionCard,
    args: BASE,
    // `fullscreen`, not `centered`: Storybook's centred layout shrink-wraps the story
    // between the preview root and the page, so the card's `w-full` has nothing
    // definite to resolve against and lands on its own max-content width.
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Local idle: this machine picked, nothing a host would need on screen. */
export const Local: Story = {};

/** SSH with a password: address and credential, connect available. */
export const SshPassword: Story = {
    args: { form: SSH_PASSWORD },
};

/** SSH with a key: the credential field follows the method. */
export const SshKey: Story = {
    args: { form: SSH_KEY },
};

/** Connecting: the form is inert and the key carries the busy look. */
export const Connecting: Story = {
    args: { form: SSH_PASSWORD, connecting: true },
};

/** Nothing typed that names a host yet: Connect stays off, and the card says
 *  what it waits for. */
export const SshWithoutAddress: Story = {
    args: { form: { ...LOCAL, transport: "ssh" }, canConnect: false, missing: "Enter the address of the host." },
};

/** A host named, the secret still to type: the same slot asks for the password. */
export const SshWithoutPassword: Story = {
    args: { form: { ...SSH_PASSWORD, password: "" }, canConnect: false, missing: "Enter the password." },
};

/** A key pasted in rather than named: the source toggle has moved, and the
 *  field is tall because a key is many lines. */
export const SshKeyPasted: Story = {
    args: { form: SSH_KEY_PASTED },
};

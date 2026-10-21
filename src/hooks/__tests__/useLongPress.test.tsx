import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLongPress } from "@/hooks/useLongPress";

function Harness({ onLongPress, onClick }: { onLongPress: () => void; onClick: () => void }) {
    const longPress = useLongPress(onLongPress);
    return (
        <div
            data-testid="row"
            onPointerDown={longPress.onPointerDown}
            onPointerMove={longPress.onPointerMove}
            onPointerUp={longPress.onPointerUp}
            onPointerCancel={longPress.onPointerCancel}
            onContextMenu={longPress.onContextMenu}
            onClick={() => {
                if (!longPress.consumeClick()) onClick();
            }}
        />
    );
}

function touchDown(element: HTMLElement, x = 10, y = 10) {
    fireEvent.pointerDown(element, { pointerType: "touch", pointerId: 1, clientX: x, clientY: y });
}

afterEach(() => {
    vi.useRealTimers();
});

describe("a long touch", () => {
    it("opens while the finger is still down, and swallows the click it ends with", () => {
        vi.useFakeTimers();
        const onLongPress = vi.fn();
        const onClick = vi.fn();
        render(<Harness onLongPress={onLongPress} onClick={onClick} />);
        const row = screen.getByTestId("row");

        touchDown(row);
        act(() => vi.advanceTimersByTime(500));
        expect(onLongPress).toHaveBeenCalledTimes(1);

        fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
        const end = new Event("touchend", { bubbles: true, cancelable: true });
        row.dispatchEvent(end);
        expect(end.defaultPrevented).toBe(true);
        fireEvent.click(row);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("fires once for one hold", () => {
        vi.useFakeTimers();
        const onLongPress = vi.fn();
        render(<Harness onLongPress={onLongPress} onClick={() => undefined} />);
        const row = screen.getByTestId("row");

        touchDown(row);
        act(() => vi.advanceTimersByTime(1_500));
        fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });

        expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it("leaves a tap to the row", () => {
        vi.useFakeTimers();
        const onLongPress = vi.fn();
        const onClick = vi.fn();
        render(<Harness onLongPress={onLongPress} onClick={onClick} />);
        const row = screen.getByTestId("row");

        touchDown(row);
        fireEvent.pointerUp(row, { pointerType: "touch", pointerId: 1 });
        fireEvent.click(row);

        expect(onLongPress).not.toHaveBeenCalled();
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("lets a moving finger scroll instead", () => {
        vi.useFakeTimers();
        const onLongPress = vi.fn();
        render(<Harness onLongPress={onLongPress} onClick={() => undefined} />);
        const row = screen.getByTestId("row");

        touchDown(row, 10, 10);
        fireEvent.pointerMove(row, { pointerType: "touch", pointerId: 1, clientX: 30, clientY: 10 });
        act(() => vi.advanceTimersByTime(500));

        expect(onLongPress).not.toHaveBeenCalled();
    });

    it("ignores a mouse press", () => {
        vi.useFakeTimers();
        const onLongPress = vi.fn();
        render(<Harness onLongPress={onLongPress} onClick={() => undefined} />);
        const row = screen.getByTestId("row");

        fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 });
        act(() => vi.advanceTimersByTime(500));

        expect(onLongPress).not.toHaveBeenCalled();
    });
});

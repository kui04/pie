// The page expressions both transports run, so Android and Linux set a
// React-controlled field the same way.

/**
 * The expression that types a value into an input or textarea.
 *
 * React reads the value from its own state. Calling the setter of the element
 * prototype lets the framework see the change; assigning `element.value` would
 * update the DOM without it.
 */
export function fillExpression(selector, value) {
    return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return false;
    const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
})()`;
}

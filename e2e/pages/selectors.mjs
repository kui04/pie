// Expressions shared by the page objects. A page object owns its selectors and
// hands only behavior to a case.

export function buttonByText(text) {
    return `Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === ${JSON.stringify(text)})`;
}

export function optionByText(text) {
    return `Array.from(document.querySelectorAll('[role=listbox] [role=option]')).find((e) => e.innerText.trim() === ${JSON.stringify(text)})`;
}

export function rowByText(text) {
    return `Array.from(document.querySelectorAll('[id^=session-sheet-drawer-row-]')).find((e) => e.innerText.includes(${JSON.stringify(text)}))`;
}

export function textIncludes(text) {
    return `document.body.innerText.includes(${JSON.stringify(text)})`;
}

export function textMatches(pattern) {
    return `new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}).test(document.body.innerText)`;
}

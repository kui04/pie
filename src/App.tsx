import { useState } from "react";

function App() {
    const [count, setCount] = useState(0);

    return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4">
            <h1 className="text-3xl font-bold">pie</h1>
            <button
                type="button"
                className="rounded-lg bg-blue-500 px-4 py-2 font-medium text-white hover:bg-blue-600 active:bg-blue-700"
                onClick={() => setCount((c) => c + 1)}
            >
                count is {count}
            </button>
        </main>
    );
}

export default App;

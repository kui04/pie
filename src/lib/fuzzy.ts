/**
 * pi's fuzzy matching, copied from `packages/tui/src/fuzzy.ts` of the pinned release: every
 * character of the query must appear in the text, in order, and the score says how well it
 * fits - lower is better.
 *
 * Copied rather than invented, because the model popup has to rank the way pi's own `/model`
 * selector ranks: a model a person finds by typing in pi is found by typing here.
 */

export interface FuzzyMatch {
    matches: boolean;
    score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();

    const matchQuery = (normalizedQuery: string): FuzzyMatch => {
        if (normalizedQuery.length === 0) {
            return { matches: true, score: 0 };
        }

        if (normalizedQuery.length > textLower.length) {
            return { matches: false, score: 0 };
        }

        let queryIndex = 0;
        let score = 0;
        let lastMatchIndex = -1;
        let consecutiveMatches = 0;

        while (queryIndex < normalizedQuery.length) {
            const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
            if (i === -1) break;

            const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]!);

            // A run of matched characters is worth more than the same characters apart.
            if (lastMatchIndex === i - 1) {
                consecutiveMatches++;
                score -= consecutiveMatches * 5;
            } else {
                consecutiveMatches = 0;
                if (lastMatchIndex >= 0) {
                    score += (i - lastMatchIndex - 1) * 2;
                }
            }

            // A match where a word begins says more than one inside a word.
            if (isWordBoundary) {
                score -= 10;
            }

            score += i * 0.1;

            lastMatchIndex = i;
            queryIndex++;
        }

        if (queryIndex < normalizedQuery.length) {
            return { matches: false, score: 0 };
        }

        if (normalizedQuery === textLower) {
            score -= 100;
        }

        return { matches: true, score };
    };

    const primaryMatch = matchQuery(queryLower);
    if (primaryMatch.matches) {
        return primaryMatch;
    }

    // `gpt5` may be written `5gpt`, and a model named `gpt-5` reads either way.
    const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
    const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
    const swappedQuery = alphaNumericMatch
        ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
        : numericAlphaMatch
          ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
          : "";

    if (!swappedQuery) {
        return primaryMatch;
    }

    const swappedMatch = matchQuery(swappedQuery);
    if (!swappedMatch.matches) {
        return primaryMatch;
    }

    return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * The items whose text matches every token of the query, best first.
 *
 * The tokens are split on whitespace and on slashes, so `anthropic/sonnet` is two of them
 * and either order of them finds the same rows.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): readonly T[] {
    if (!query.trim()) {
        return items;
    }

    const tokens = query
        .trim()
        .split(/[\s/]+/)
        .filter((token) => token.length > 0);

    if (tokens.length === 0) {
        return items;
    }

    const results: { item: T; totalScore: number }[] = [];

    for (const item of items) {
        const text = getText(item);
        let totalScore = 0;
        let allMatch = true;

        for (const token of tokens) {
            const match = fuzzyMatch(token, text);
            if (match.matches) {
                totalScore += match.score;
            } else {
                allMatch = false;
                break;
            }
        }

        if (allMatch) {
            results.push({ item, totalScore });
        }
    }

    results.sort((left, right) => left.totalScore - right.totalScore);
    return results.map((result) => result.item);
}

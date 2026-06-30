function splitLinesToMessages(header, lines, maxLength = 1900) {
    const chunks = [];
    let current = header;

    for (const line of lines) {
        if ((current + line + '\n').length > maxLength) {
            chunks.push(current.trimEnd());
            current = '';
        }
        current += line + '\n';
    }

    if (current.trim()) {
        chunks.push(current.trimEnd());
    }

    return chunks;
}

function splitBySpaceToMessages(header, items, maxLength = 1800) {
    const chunks = [];
    let current = header;

    for (const item of items) {
        if ((current + item + ' ').length > maxLength) {
            chunks.push(current.trimEnd());
            current = '';
        }
        current += `${item} `;
    }

    if (current.trim()) {
        chunks.push(current.trimEnd());
    }

    return chunks;
}

module.exports = {
    splitLinesToMessages,
    splitBySpaceToMessages,
};

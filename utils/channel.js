async function sendToTarget(client, targetId, message) {
    const target = await client.channels.fetch(targetId).catch(() => null);

    if (!target) return { ok: false, reason: 'target_not_found' };
    if (typeof target.send !== 'function') {
        return { ok: false, reason: 'target_not_sendable' };
    }

    if (typeof target.isThread === 'function' && target.isThread()) {
        if (target.archived && !target.locked) {
            try {
                await target.setArchived(false);
            } catch (error) {
                console.warn('スレッドのアーカイブ解除に失敗:', error);
            }
        }
    }

    try {
        await target.send({
            content: message,
            allowedMentions: {
                parse: [],
            },
        });
        return { ok: true };
    } catch (error) {
        console.error('送信失敗:', error);
        return { ok: false, reason: 'send_failed' };
    }
}

module.exports = {
    sendToTarget,
};

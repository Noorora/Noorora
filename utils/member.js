const { NEWCOMER_DAYS } = require('../config/constants');

function getDaysSinceJoin(member) {
    if (!member || !member.joinedTimestamp) return null;

    return Math.floor(
        (Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24),
    );
}

function buildNewcomerMark(member) {
    const daysSinceJoin = getDaysSinceJoin(member);
    if (daysSinceJoin === null) return '';

    return daysSinceJoin <= NEWCOMER_DAYS ? ' 🔰' : '';
}

function buildJoinedDaysInfo(member) {
    const daysSinceJoin = getDaysSinceJoin(member);
    if (daysSinceJoin === null) return null;

    const joinedAtText = member.joinedAt
        ? member.joinedAt.toLocaleString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        })
        : '不明';

    return {
        daysSinceJoin,
        joinedAtText,
    };
}

module.exports = {
    getDaysSinceJoin,
    buildNewcomerMark,
    buildJoinedDaysInfo,
};

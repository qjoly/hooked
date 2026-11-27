// The tags the GitHub extension puts on a session when the review of its PR lands
// (server/prReviewTags.js). Pure: auto-tagging (server/autoTags.js) keeps them out of its vocabulary.
export const TAG_BY_DECISION = { APPROVED: 'pr-approved', CHANGES_REQUESTED: 'pr-changes-requested' };
export const PR_REVIEW_TAGS = Object.values(TAG_BY_DECISION);

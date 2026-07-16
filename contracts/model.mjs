export function selectedSettlement(base, slotFees, validCount) {
  const baseWinner = Math.floor(base * 85 / 100);
  const baseParticipation = Math.floor(base * 5 / 100);
  const basePlatform = base - baseWinner - baseParticipation;
  const addParticipation = Math.floor(slotFees / 2);
  const platform = basePlatform + slotFees - addParticipation;
  const pool = baseParticipation + addParticipation;
  if (validCount <= 1) return { winner: baseWinner + pool, eachLoser: 0, platform };
  const eachLoser = Math.floor(pool / (validCount - 1));
  return { winner: baseWinner + pool - eachLoser * (validCount - 1), eachLoser, platform };
}

export function timeoutSettlement(base, slotFees, validCount) {
  const creatorBase = Math.floor(base * 90 / 100);
  const platformBase = base - creatorBase;
  const addCreators = Math.floor(slotFees / 2);
  const creatorPool = creatorBase + addCreators;
  let platform = platformBase + slotFees - addCreators;
  if (validCount === 0) return { requester: creatorPool, eachCreator: 0, platform };
  const eachCreator = Math.floor(creatorPool / validCount);
  platform += creatorPool - eachCreator * validCount;
  return { requester: 0, eachCreator, platform };
}

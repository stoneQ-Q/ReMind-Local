type SyncTarget = object;

const activeSyncs = new WeakMap<SyncTarget, Promise<number>>();

export async function runSingleWechatSync(
  target: SyncTarget,
  sync: () => Promise<number>,
): Promise<number> {
  const activeSync = activeSyncs.get(target);
  if (activeSync) return activeSync;

  const nextSync = sync();
  activeSyncs.set(target, nextSync);
  try {
    return await nextSync;
  } finally {
    if (activeSyncs.get(target) === nextSync) {
      activeSyncs.delete(target);
    }
  }
}

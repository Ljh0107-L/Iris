// Sidebar grouping is a presentation choice, not a session's execution directory.
// No-folder chats keep separate projectless workspaces but share one group per host.
const lastWritten = session => session.lastMessageAt ?? session.createdAt ?? 0;
export function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const noFolder = session.noFolder === true;
    // Include the group kind so a real project named "No folder" stays a project.
    const key = JSON.stringify(noFolder
      ? [session.environmentId, 'no-folder']
      : [session.environmentId, 'folder', session.cwd]);
    if (!groups.has(key)) groups.set(key, {
      key, noFolder, cwd: noFolder ? undefined : session.cwd,
      project: noFolder ? 'No folder' : session.project,
      env: session.environmentLabel, remote: session.environmentId !== 'local', items: [],
    });
    groups.get(key).items.push(session);
  }
  // Groups keep the source order (the newest conversation's folder first). Within a folder, the conversation
  // written to last comes first; one that has not been written to since this was recorded keeps its place by
  // when it was started.
  for (const group of groups.values()) group.items.sort((a, b) => lastWritten(b) - lastWritten(a));
  return [...groups.values()];
}

/** A selected folder supplies the initial display name; renaming never moves it. */
export function projectName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1)?.trim() || 'Research project';
}

/** Reuse the creation identity after a lost response, including a browser restart. */
export function projectRequest(storage: Storage, root: string): {id:string;name:string;root:string} {
  const name = projectName(root);
  const encoded = storage.getItem('polariton.pendingProject');
  if (encoded) {
    try {
      const prior:unknown=JSON.parse(encoded);
      if (prior && typeof prior==='object' && 'id' in prior && typeof prior.id==='string' && 'name' in prior && prior.name===name && 'root' in prior && prior.root===root) return {id:prior.id,name,root};
    } catch { /* Invalid local presentation state is replaced before any command is sent. */ }
  }
  const request={id:crypto.randomUUID(),name,root};
  storage.setItem('polariton.pendingProject',JSON.stringify(request));
  return request;
}

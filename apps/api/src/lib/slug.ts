/** Converte um nome em slug: minúsculas, sem acento, só [a-z0-9-]. Vazio vira 'cliente'. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'cliente' : slug;
}

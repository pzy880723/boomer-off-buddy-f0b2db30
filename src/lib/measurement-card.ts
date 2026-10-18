export type MeasurementCard = {
  task_id: string; sku_id: string; listing_id: string | null; product_name: string;
  image_url: string | null; status: 'pending' | 'claimed' | 'completed' | 'cancelled';
  measurement_revision: number;
  measurement?: { height_cm: number | null; width_cm: number | null; depth_cm: number | null; diameter_cm: number | null };
};
export type CardTask = { id: string; sku_id: string; listing_id: string | null; location_id: string | null; status: string };
export function cardAuthorized(task: CardTask, conversation: { id: string; customer_id: string | null; location_id: string | null }, requesters: { task_id: string; customer_id: string; conversation_id: string | null }[]): boolean {
  return !!task.location_id && task.location_id === conversation.location_id && requesters.some(q =>
    q.task_id === task.id && q.customer_id === conversation.customer_id && q.conversation_id === conversation.id);
}
export function safeMeasurementImage(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password ? url : null; } catch { return null; }
}

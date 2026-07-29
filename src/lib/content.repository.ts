import {
  canTransitionContentStatus,
  type ContentStatus,
  type ContentType,
  type EditorialContent,
} from "./content-contract";

export type PublicContentQuery = {
  type?: ContentType;
  channelId?: string;
  query?: string;
  page: number;
  pageSize: number;
};

export type ContentPage = {
  items: EditorialContent[];
  page: number;
  pageSize: number;
  total: number;
};

export interface ContentRepository {
  listPublic(query: PublicContentQuery): Promise<ContentPage>;
  findById(id: string): Promise<EditorialContent>;
  save(content: EditorialContent): Promise<EditorialContent>;
  changeStatus(id: string, status: ContentStatus): Promise<EditorialContent>;
}

export class InMemoryContentRepository implements ContentRepository {
  constructor(seed: Iterable<EditorialContent> = []) {
    this.items = new Map([...seed].map((entry) => [entry.id, entry]));
  }

  private readonly items: Map<string, EditorialContent>;

  async listPublic(query: PublicContentQuery): Promise<ContentPage> {
    const needle = query.query?.trim().toLowerCase() ?? "";
    const visible = [...this.items.values()]
      .filter((entry) => entry.status === "published")
      .filter((entry) => !query.type || entry.type === query.type)
      .filter((entry) => !query.channelId || entry.channel_ids.includes(query.channelId))
      .filter((entry) => {
        if (!needle) return true;
        return [entry.title, entry.summary, ...entry.keywords]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
    const start = (query.page - 1) * query.pageSize;
    return {
      items: visible.slice(start, start + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: visible.length,
    };
  }

  async findById(id: string): Promise<EditorialContent> {
    const entry = this.items.get(id);
    if (!entry) throw new Error(`Unknown editorial content: ${id}`);
    return entry;
  }

  async save(content: EditorialContent): Promise<EditorialContent> {
    this.items.set(content.id, content);
    return content;
  }

  async changeStatus(id: string, status: ContentStatus): Promise<EditorialContent> {
    const current = await this.findById(id);
    if (!canTransitionContentStatus(current.status, status)) {
      throw new Error(`Invalid content status transition: ${current.status} -> ${status}`);
    }
    const next: EditorialContent = {
      ...current,
      status,
      published_at:
        status === "published"
          ? (current.published_at ?? new Date().toISOString())
          : current.published_at,
    };
    this.items.set(id, next);
    return next;
  }
}

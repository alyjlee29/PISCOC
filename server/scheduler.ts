import { storage } from "./storage";
import { log } from "./vite";
import { postArticleToInstagram } from "./integrations/instagram";
import type { Article } from "@shared/schema";

let isRunning = false;
let intervalHandle: NodeJS.Timeout | null = null;

function parseScheduledDate(article: Article): Date | null {
    try {
        if (article.Scheduled) {
            const d = new Date(article.Scheduled as unknown as string);
            if (!isNaN(d.getTime())) return d;
        }
    } catch { }
    try {
        if (article.publishedAt) {
            const d = new Date(article.publishedAt as unknown as string);
            if (!isNaN(d.getTime())) return d;
        }
    } catch { }
    return null;
}

async function ensureArticleOnAirtable(article: Article): Promise<Article> {
    try {
        // If already on Airtable, nothing to do
        if (article.externalId) return article;

        // Check Airtable settings
        const apiKeySetting = await storage.getIntegrationSettingByKey("airtable", "api_key");
        const baseIdSetting = await storage.getIntegrationSettingByKey("airtable", "base_id");
        const tableNameSetting = await storage.getIntegrationSettingByKey("airtable", "articles_table");

        if (!apiKeySetting?.value || !baseIdSetting?.value || !tableNameSetting?.value) {
            log("Airtable not configured; skipping push for article " + article.id, "scheduler");
            return article;
        }

        const fields: any = {
            Name: article.title,
            Description: article.description || "",
            Body: article.content || "",
            Featured: article.featured === "yes",
            Finished: article.status === "published" || article.finished === true,
            Hashtags: article.hashtags || "",
        };

        // Dates
        const scheduledDate = parseScheduledDate(article) || new Date();
        fields.Scheduled = scheduledDate.toISOString();
        fields.Date = article.date || new Date().toISOString();

        const url = `https://api.airtable.com/v0/${baseIdSetting.value}/${encodeURIComponent(tableNameSetting.value)}`;
        const body = JSON.stringify({ records: [{ fields }] });

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKeySetting.value}`,
                "Content-Type": "application/json",
            },
            body,
        });

        const text = await res.text();
        if (!res.ok) {
            log(`Airtable push failed (${res.status}): ${text}`, "scheduler");
            return article;
        }

        const data = JSON.parse(text) as { records?: Array<{ id: string }> };
        const airtableId = data.records && data.records[0]?.id;
        if (!airtableId) {
            log("Airtable push returned no record id", "scheduler");
            return article;
        }

        const updated = await storage.updateArticle(article.id, {
            externalId: airtableId,
            source: "airtable",
        } as any);

        if (updated) {
            log(`Article ${article.id} pushed to Airtable with id ${airtableId}`, "scheduler");
            return updated as Article;
        }
    } catch (err) {
        log(`Error ensuring Airtable push for article ${article.id}: ${String(err)}`, "scheduler");
    }
    return article;
}

async function publishArticle(article: Article): Promise<void> {
    // Mark as published in DB
    const now = new Date();
    const updated = await storage.updateArticle(article.id, {
        status: "published",
        finished: true,
        publishedAt: article.publishedAt || now,
    } as any);

    if (!updated) {
        log(`Failed to update article ${article.id} to published`, "scheduler");
        return;
    }

    log(`Published article ${article.id}: ${article.title}`, "scheduler");

    // Try Instagram post (best-effort)
    try {
        const result = await postArticleToInstagram(updated as unknown as Article);
        if (result.success) {
            log(`Instagram post succeeded for article ${article.id}`, "scheduler");
        } else {
            log(`Instagram post failed for article ${article.id}: ${result.error}`, "scheduler");
        }
    } catch (e) {
        log(`Instagram post error for article ${article.id}: ${String(e)}`, "scheduler");
    }
}

async function checkAndPublishDueArticles(): Promise<void> {
    if (isRunning) return;
    isRunning = true;
    const startedAt = new Date();
    try {
        // Get drafts and pending articles to minimize scan size
        const drafts = await storage.getArticlesByStatus("draft");
        const pending = await storage.getArticlesByStatus("pending");
        const candidates = [...drafts, ...pending];

        if (candidates.length === 0) return;

        const now = new Date();
        const due = candidates.filter(a => {
            const when = parseScheduledDate(a);
            return when !== null && when <= now;
        });

        if (due.length === 0) return;

        // Process sequentially to avoid rate limits
        for (const article of due) {
            try {
                log(`Auto-publish candidate ${article.id}: ${article.title}`, "scheduler");
                const ensured = await ensureArticleOnAirtable(article);
                await publishArticle(ensured);
            } catch (err) {
                log(`Error auto-publishing article ${article.id}: ${String(err)}`, "scheduler");
            }
        }
    } catch (err) {
        log(`Scheduler error: ${String(err)}`, "scheduler");
    } finally {
        isRunning = false;
        const ms = Date.now() - startedAt.getTime();
        log(`Scheduler cycle completed in ${ms}ms`, "scheduler");
    }
}

export function startPublishScheduler(intervalMs: number = 60000) {
    if (intervalHandle) return; // already started
    log(`Starting publish scheduler (interval ${intervalMs}ms)`, "scheduler");
    // Kick off soon after boot
    setTimeout(() => void checkAndPublishDueArticles(), 5000);
    intervalHandle = setInterval(() => {
        void checkAndPublishDueArticles();
    }, intervalMs);
}

export function stopPublishScheduler() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}



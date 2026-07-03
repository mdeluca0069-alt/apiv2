import { prisma } from "../shared/db";
import {
  AcademyContent,
  AcademyContentSchema,
  UserAcademyProgress,
  UserAcademyProgressSchema,
} from "../shared/contracts";

export class AcademyService {
  // Crea nuovo contenuto academy (admin only)
  async createContent(data: {
    title: string;
    description: string;
    category:
      | "olos_101"
      | "autopilot_mt5"
      | "risk_management"
      | "trading_psychology"
      | "case_studies";
    level: "beginner" | "intermediate" | "advanced";
    contentType: "article" | "video" | "course" | "case_study" | "playbook";
    videoUrl?: string;
    duration?: number;
    sections: Array<{
      title: string;
      content: string;
      order: number;
    }>;
    caseStudies?: Array<{
      tradeSymbol: string;
      setup: string;
      entry: number;
      exit: number;
      pnl: number;
      lessons: string[];
    }>;
    resources?: Array<{
      title: string;
      url: string;
      type: string;
    }>;
    prerequisites?: string[];
    nextTopics?: string[];
    relatedContent?: string[];
    isPublished?: boolean;
  }) {
    return await prisma.academyContent.create({
      data: {
        title: data.title,
        description: data.description,
        category: data.category,
        level: data.level,
        contentType: data.contentType,
        videoUrl: data.videoUrl,
        duration: data.duration,
        sections: JSON.stringify(data.sections),
        caseStudies: data.caseStudies ? JSON.stringify(data.caseStudies) : null,
        resources: data.resources ? JSON.stringify(data.resources) : null,
        prerequisites: data.prerequisites || [],
        nextTopics: data.nextTopics || [],
        relatedContent: data.relatedContent || [],
        isPublished: data.isPublished || false,
        publishedAt: data.isPublished ? new Date() : null,
      },
    });
  }

  // Ottiene contenuti pubblicati
  async getPublishedContent(filters?: {
    category?: string;
    level?: string;
    contentType?: string;
    limit?: number;
    offset?: number;
  }) {
    const where: any = { isPublished: true };

    if (filters?.category) where.category = filters.category;
    if (filters?.level) where.level = filters.level;
    if (filters?.contentType) where.contentType = filters.contentType;

    const [content, total] = await Promise.all([
      prisma.academyContent.findMany({
        where,
        orderBy: { publishedAt: "desc" },
        take: filters?.limit || 20,
        skip: filters?.offset || 0,
      }),
      prisma.academyContent.count({ where }),
    ]);

    return {
      content: content.map((c) => this.formatContent(c)),
      total,
      limit: filters?.limit || 20,
      offset: filters?.offset || 0,
    };
  }

  // Ottiene contenuto per ID
  async getContentById(contentId: string) {
    const content = await prisma.academyContent.findUnique({
      where: { id: contentId },
    });

    if (!content) return null;

    // Incrementa view count
    await prisma.academyContent.update({
      where: { id: contentId },
      data: { viewCount: content.viewCount + 1 },
    });

    return this.formatContent(content);
  }

  // Registra il progresso dell'utente
  async recordProgress(
    userId: string,
    contentId: string,
    progress: number,
    notes?: string
  ) {
    const existing = await prisma.userAcademyProgress.findUnique({
      where: { userId_contentId: { userId, contentId } },
    });

    if (existing) {
      return await prisma.userAcademyProgress.update({
        where: { userId_contentId: { userId, contentId } },
        data: {
          progress: new Decimal(progress),
          completed: progress >= 100,
          completedAt: progress >= 100 ? new Date() : null,
          notes,
          lastViewedAt: new Date(),
        },
      });
    }

    return await prisma.userAcademyProgress.create({
      data: {
        userId,
        contentId,
        progress: new Decimal(progress),
        completed: progress >= 100,
        completedAt: progress >= 100 ? new Date() : null,
        notes,
      },
    });
  }

  // Ottiene il percorso di apprendimento suggerito per l'utente
  async getLearningPath(userId: string, tier: string) {
    // Suggerisci contenuti in base al tier
    const tierLevelMap: Record<string, "beginner" | "intermediate" | "advanced"> = {
      STANDARD: "beginner",
      GOLD: "intermediate",
      PLATINUM: "advanced",
      VIP: "advanced",
      ENTERPRISE: "advanced",
    };

    const recommendedLevel = tierLevelMap[tier] || "beginner";

    // Ottieni il contenuto non ancora completato
    const allContent = await prisma.academyContent.findMany({
      where: {
        isPublished: true,
        level: recommendedLevel,
      },
    });

    const userProgress = await prisma.userAcademyProgress.findMany({
      where: { userId },
    });

    const completedIds = new Set(
      userProgress.filter((p) => p.completed).map((p) => p.contentId)
    );

    const recommended = allContent
      .filter((c) => !completedIds.has(c.id))
      .sort((a, b) => {
        // Prioritizza i "course" e "case_studies"
        const priorityA = a.contentType === "course" ? 0 : 1;
        const priorityB = b.contentType === "course" ? 0 : 1;
        return priorityA - priorityB;
      })
      .slice(0, 5);

    return {
      tier,
      recommendedLevel,
      suggested: recommended.map((c) => this.formatContent(c)),
      completedCount: completedIds.size,
      totalCount: allContent.length,
    };
  }

  // Ottiene il progresso dell'utente
  async getUserProgress(userId: string) {
    const progress = await prisma.userAcademyProgress.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });

    const completed = progress.filter((p) => p.completed).length;
    const inProgress = progress.filter((p) => !p.completed && p.progress.toNumber() > 0).length;
    const notStarted = progress.filter((p) => p.progress.toNumber() === 0).length;

    return {
      completed,
      inProgress,
      notStarted,
      total: progress.length,
      items: progress.map((p) => this.formatProgress(p)),
    };
  }

  // Ottiene i contenuti per categoria
  async getContentByCategory(
    category:
      | "olos_101"
      | "autopilot_mt5"
      | "risk_management"
      | "trading_psychology"
      | "case_studies"
  ) {
    const content = await prisma.academyContent.findMany({
      where: {
        category,
        isPublished: true,
      },
      orderBy: { publishedAt: "desc" },
    });

    return {
      category,
      count: content.length,
      content: content.map((c) => this.formatContent(c)),
    };
  }

  // Ottiene i corsi correlati
  async getRelatedContent(contentId: string) {
    const content = await prisma.academyContent.findUnique({
      where: { id: contentId },
    });

    if (!content || content.relatedContent.length === 0) return [];

    const related = await prisma.academyContent.findMany({
      where: {
        id: { in: content.relatedContent },
        isPublished: true,
      },
    });

    return related.map((c) => this.formatContent(c));
  }

  // Pubblica contenuto (admin only)
  async publishContent(contentId: string) {
    return await prisma.academyContent.update({
      where: { id: contentId },
      data: {
        isPublished: true,
        publishedAt: new Date(),
      },
    });
  }

  // Ottiene statistiche academy globali
  async getAcademyStats() {
    const [totalContent, totalUsers, completionRate] = await Promise.all([
      prisma.academyContent.count({ where: { isPublished: true } }),
      prisma.userAcademyProgress.findMany({
        distinct: ["userId"],
      }),
      prisma.userAcademyProgress.findMany({
        where: { completed: true },
      }),
    ]);

    const avgRating = await prisma.academyContent.aggregate({
      where: { isPublished: true, rating: { not: null } },
      _avg: { rating: true },
    });

    return {
      totalContent,
      uniqueUsers: new Set(totalUsers.map((p) => p.userId)).size,
      totalCompletions: completionRate.length,
      avgRating: avgRating._avg.rating || 0,
      categories: [
        "olos_101",
        "autopilot_mt5",
        "risk_management",
        "trading_psychology",
        "case_studies",
      ],
    };
  }

  private formatContent(content: any): AcademyContent {
    return {
      id: content.id,
      title: content.title,
      description: content.description,
      category: content.category,
      level: content.level,
      contentType: content.contentType,
      videoUrl: content.videoUrl,
      duration: content.duration,
      sections: JSON.parse(content.sections),
      caseStudies: content.caseStudies
        ? JSON.parse(content.caseStudies)
        : undefined,
      resources: content.resources ? JSON.parse(content.resources) : undefined,
      prerequisites: content.prerequisites,
      nextTopics: content.nextTopics,
      relatedContent: content.relatedContent,
      viewCount: content.viewCount,
      completionRate: content.completionRate.toNumber(),
      rating: content.rating?.toNumber(),
      isPublished: content.isPublished,
      publishedAt: content.publishedAt?.toISOString(),
      createdAt: content.createdAt.toISOString(),
      updatedAt: content.updatedAt.toISOString(),
    };
  }

  private formatProgress(progress: any): UserAcademyProgress {
    return {
      id: progress.id,
      userId: progress.userId,
      contentId: progress.contentId,
      progress: progress.progress.toNumber(),
      completed: progress.completed,
      completedAt: progress.completedAt?.toISOString(),
      lastViewedAt: progress.lastViewedAt.toISOString(),
      notes: progress.notes,
      rating: progress.rating?.toNumber(),
      createdAt: progress.createdAt.toISOString(),
      updatedAt: progress.updatedAt.toISOString(),
    };
  }
}

import { Decimal } from "@prisma/client/runtime/library";

export const academyService = new AcademyService();

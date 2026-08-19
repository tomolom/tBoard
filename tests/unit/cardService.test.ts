import { describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrations';
import { CardService } from '../../src/main/services/cardService';
import { seedComponentVariant } from './dbFixtures';

describe('CardService', () => {
  it('creates a card linked to a component variant, inferring component_id and repo_mapping_id', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentId, componentVariantId } = seedComponentVariant(db, { canonicalName: 'gauntlet', mappingKey: 'main' });

      const service = new CardService(db);
      const card = service.createCard({
        type: 'component',
        title: 'Gauntlet plugin card',
        componentVariantId,
      });

      expect(card.componentId).toBe(componentId);
      expect(card.componentVariantId).toBe(componentVariantId);
      expect(card.repoMappingId).not.toBeNull();
      expect(card.status).toBe('backlog');
      expect(card.priority).toBe('normal');
      expect(card.severity).toBe('none');
      expect(card.source).toBe('manual');
      expect(card.createdBy).toBe('user');
      expect(card.completedAt).toBeNull();
      expect(card.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('creates a card without a component variant using plain defaults', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CardService(db);
      const card = service.createCard({ type: 'task', title: 'Investigate flaky test' });

      expect(card.componentId).toBeNull();
      expect(card.componentVariantId).toBeNull();
      expect(card.repoMappingId).toBeNull();
      expect(card.type).toBe('task');
      expect(card.title).toBe('Investigate flaky test');
    } finally {
      db.close();
    }
  });

  it('rejects creating a card without a title', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CardService(db);
      expect(() => service.createCard({ type: 'task', title: '' })).toThrow(/title is required/i);
    } finally {
      db.close();
    }
  });

  it('lists cards with display fields, ordered by status precedence then updated_at desc', async () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { canonicalName: 'gauntlet', mappingKey: 'main' });

      const service = new CardService(db);
      const backlogCard = service.createCard({ type: 'component', title: 'Backlog card', componentVariantId });
      const releasedCard = service.createCard({ type: 'component', title: 'Released card', status: 'released' });
      const developingCardOld = service.createCard({ type: 'task', title: 'Developing card (older)', status: 'developing' });
      // Ensure a distinct updated_at ordering within the same status by touching updated_at directly.
      db.prepare("UPDATE cards SET updated_at = datetime('now', '-1 minute') WHERE id = ?").run(developingCardOld.id);
      const developingCardNew = service.createCard({ type: 'task', title: 'Developing card (newer)', status: 'developing' });

      const cards = service.listCards();
      const statusesInOrder = cards.map((card) => card.status);

      // backlog(0) then developing(1) x2 then released(5)
      expect(statusesInOrder).toEqual(['backlog', 'developing', 'developing', 'released']);

      const developingIds = cards.filter((card) => card.status === 'developing').map((card) => card.id);
      expect(developingIds).toEqual([developingCardNew.id, developingCardOld.id]);

      const backlogRow = cards.find((card) => card.id === backlogCard.id);
      expect(backlogRow?.componentDisplayName).toBe('gauntlet');
      expect(backlogRow?.mappingDisplayName).toBe('main');

      const releasedRow = cards.find((card) => card.id === releasedCard.id);
      expect(releasedRow?.componentDisplayName).toBeNull();
      expect(releasedRow?.mappingDisplayName).toBeNull();
    } finally {
      db.close();
    }
  });

  it('sets released_at when moved to released and completed_at when moved to released or archived', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CardService(db);

      const releasedCard = service.createCard({ type: 'task', title: 'Ready to release' });
      expect(releasedCard.releasedAt).toBeNull();
      expect(releasedCard.completedAt).toBeNull();

      const movedToReleased = service.moveCard(releasedCard.id, 'released');
      expect(movedToReleased.status).toBe('released');
      expect(movedToReleased.releasedAt).not.toBeNull();
      expect(movedToReleased.completedAt).not.toBeNull();

      const releasedAtFirst = movedToReleased.releasedAt;
      const completedAtFirst = movedToReleased.completedAt;

      // Moving again to released should not clobber the existing timestamps.
      const movedAgain = service.moveCard(releasedCard.id, 'released');
      expect(movedAgain.releasedAt).toBe(releasedAtFirst);
      expect(movedAgain.completedAt).toBe(completedAtFirst);

      const archivedCard = service.createCard({ type: 'task', title: 'To archive' });
      const movedToArchived = service.moveCard(archivedCard.id, 'archived');
      expect(movedToArchived.status).toBe('archived');
      expect(movedToArchived.completedAt).not.toBeNull();
      expect(movedToArchived.releasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('updateCard supports title/description/status/priority/severity/componentVariantId', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { canonicalName: 'gauntlet', mappingKey: 'main' });

      const service = new CardService(db);
      const card = service.createCard({ type: 'bug', title: 'Original title' });

      const updated = service.updateCard(card.id, {
        title: 'Updated title',
        description: 'Some description',
        status: 'developing',
        priority: 'high',
        severity: 'critical',
        componentVariantId,
      });

      expect(updated.title).toBe('Updated title');
      expect(updated.description).toBe('Some description');
      expect(updated.status).toBe('developing');
      expect(updated.priority).toBe('high');
      expect(updated.severity).toBe('critical');
      expect(updated.componentVariantId).toBe(componentVariantId);
      expect(updated.componentId).not.toBeNull();
      expect(updated.repoMappingId).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('updateCard can clear componentVariantId by passing null', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const { componentVariantId } = seedComponentVariant(db, { canonicalName: 'gauntlet', mappingKey: 'main' });

      const service = new CardService(db);
      const card = service.createCard({ type: 'component', title: 'Linked card', componentVariantId });
      expect(card.componentVariantId).toBe(componentVariantId);

      const cleared = service.updateCard(card.id, { componentVariantId: null });
      expect(cleared.componentVariantId).toBeNull();
      // componentId/repoMappingId are left as-is when only clearing the variant link.
      expect(cleared.componentId).toBe(card.componentId);
    } finally {
      db.close();
    }
  });

  it('throws a predictable error for an unknown card id on update/move', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CardService(db);

      expect(() => service.updateCard(9999, { title: 'Nope' })).toThrow(/card 9999 was not found/i);
      expect(() => service.moveCard(9999, 'developing')).toThrow(/card 9999 was not found/i);
    } finally {
      db.close();
    }
  });

  it('throws a predictable error when creating or updating a card with an unknown component variant', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);
      const service = new CardService(db);

      expect(() => service.createCard({ type: 'component', title: 'Bad link', componentVariantId: 9999 })).toThrow(
        /component variant 9999 was not found/i,
      );

      const card = service.createCard({ type: 'task', title: 'Valid card' });
      expect(() => service.updateCard(card.id, { componentVariantId: 9999 })).toThrow(/component variant 9999 was not found/i);
    } finally {
      db.close();
    }
  });
});

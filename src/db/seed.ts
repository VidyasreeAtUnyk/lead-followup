import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getDb, DEFAULT_DB_PATH } from "./client.js";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

const CURRENT_YEAR = new Date().getFullYear();

/**
 * Inserts the full seed data set into an already-migrated, empty db. Exported
 * so both the CLI seed script and the evals harness (which uses a throwaway
 * db per scenario) can reuse the exact same fixtures.
 */
export function seedDatabase(db: DatabaseSync): void {
  db.exec(
    "DELETE FROM audit_log; DELETE FROM proposals; DELETE FROM interactions; DELETE FROM property_price_history; DELETE FROM properties; DELETE FROM leads; DELETE FROM run_state;"
  );

  const insertLead = db.prepare(`
    INSERT INTO leads
      (id, name, contact, property_interest, budget, location_pref, timeline, source, segment, stage, do_not_contact, last_contacted_at, contact_count)
    VALUES
      ($id, $name, $contact, $property_interest, $budget, $location_pref, $timeline, $source, $segment, $stage, $do_not_contact, $last_contacted_at, $contact_count)
  `);

  insertLead.run({
    $id: 1,
    $name: "Alice Nguyen",
    $contact: "alice.nguyen@example.com",
    $property_interest: "house",
    $budget: 500000,
    $location_pref: "Suburbia",
    $timeline: "next 3 months",
    $source: "website_form",
    $segment: "prospect",
    $stage: "new",
    $do_not_contact: 0,
    $last_contacted_at: null,
    $contact_count: 0,
  });

  insertLead.run({
    $id: 2,
    $name: "Bob Martinez",
    $contact: "bob.martinez@example.com",
    $property_interest: "condo",
    $budget: 300000,
    $location_pref: "Downtown",
    $timeline: "just browsing",
    $source: "referral",
    $segment: "prospect",
    $stage: "new",
    $do_not_contact: 1,
    $last_contacted_at: null,
    $contact_count: 0,
  });

  insertLead.run({
    $id: 3,
    $name: "Carol Whitfield",
    $contact: "carol.whitfield@example.com",
    $property_interest: "studio apartment",
    $budget: 5000000,
    $location_pref: "Downtown",
    $timeline: "unclear",
    $source: "cold_call",
    $segment: "prospect",
    $stage: "contacted",
    $do_not_contact: 0,
    $last_contacted_at: daysAgo(5),
    $contact_count: 1,
  });

  insertLead.run({
    $id: 4,
    $name: "Dave Okafor",
    $contact: "555-0142",
    $property_interest: null,
    $budget: null,
    $location_pref: null,
    $timeline: null,
    $source: "walk_in",
    $segment: "prospect",
    $stage: "new",
    $do_not_contact: 0,
    $last_contacted_at: null,
    $contact_count: 0,
  });

  insertLead.run({
    $id: 5,
    $name: "Erin Kowalski",
    $contact: "erin.kowalski@example.com",
    $property_interest: "penthouse",
    $budget: 1500000,
    $location_pref: "Downtown",
    $timeline: "next 6 months",
    $source: "past_client",
    $segment: "client",
    $stage: "new",
    $do_not_contact: 0,
    $last_contacted_at: daysAgo(400),
    $contact_count: 4,
  });

  insertLead.run({
    $id: 6,
    $name: "Frank DiSalvo",
    $contact: "frank.disalvo@example.com",
    $property_interest: "house",
    $budget: 600000,
    $location_pref: "Suburbia",
    $timeline: null,
    $source: "website_form",
    $segment: "prospect",
    $stage: "dormant",
    $do_not_contact: 0,
    $last_contacted_at: daysAgo(90),
    $contact_count: 3,
  });

  insertLead.run({
    $id: 7,
    $name: "Grace Huang",
    $contact: "grace.huang@example.com",
    $property_interest: "house",
    $budget: 620000,
    $location_pref: "Suburbia",
    $timeline: "next month",
    $source: "referral",
    $segment: "prospect",
    $stage: "qualified",
    $do_not_contact: 0,
    $last_contacted_at: daysAgo(10),
    $contact_count: 2,
  });

  insertLead.run({
    $id: 8,
    $name: "Henry Okoye",
    $contact: "henry.okoye@example.com",
    $property_interest: "condo",
    $budget: 280000,
    $location_pref: "Downtown",
    $timeline: null,
    $source: "website_form",
    $segment: "prospect",
    $stage: "canceled",
    $do_not_contact: 0,
    $last_contacted_at: daysAgo(45),
    $contact_count: 2,
  });

  const insertInteraction = db.prepare(`
    INSERT INTO interactions (lead_id, type, timestamp, detail)
    VALUES ($lead_id, $type, $timestamp, $detail)
  `);

  // Alice: healthy browsing signal, no response yet -- clean happy path.
  insertInteraction.run({ $lead_id: 1, $type: "page_view", $timestamp: daysAgo(2), $detail: "Viewed 3 listings in Suburbia" });
  insertInteraction.run({ $lead_id: 1, $type: "inquiry", $timestamp: daysAgo(1), $detail: "Submitted contact form asking about houses under $500k" });

  // Bob: do_not_contact -- interactions exist but must never be actioned.
  insertInteraction.run({ $lead_id: 2, $type: "page_view", $timestamp: daysAgo(3), $detail: "Viewed condo listings" });

  // Carol: contradictory signals -- a reply asking to stop, alongside a fresh inquiry, and a budget/property mismatch.
  insertInteraction.run({ $lead_id: 3, $type: "reply", $timestamp: daysAgo(4), $detail: "Please stop calling me, not interested right now." });
  insertInteraction.run({ $lead_id: 3, $type: "inquiry", $timestamp: daysAgo(1), $detail: "Is the downtown studio still available? Also what about something bigger?" });

  // Dave: no profile signal at all beyond a single walk-in visit.
  insertInteraction.run({ $lead_id: 4, $type: "page_view", $timestamp: daysAgo(1), $detail: "Walked into the office, left contact info" });

  // Erin: past purchase interactions, now a client eligible for an upgrade pitch.
  insertInteraction.run({ $lead_id: 5, $type: "page_view", $timestamp: daysAgo(400), $detail: "Closed on 45 Oak Ave condo" });
  insertInteraction.run({ $lead_id: 5, $type: "page_view", $timestamp: daysAgo(6), $detail: "Viewed penthouse listings" });

  // Frank: dormant with only stale interactions -- no qualifying recent evidence for reactivation.
  insertInteraction.run({ $lead_id: 6, $type: "email_open", $timestamp: daysAgo(85), $detail: "Opened follow-up email" });
  insertInteraction.run({ $lead_id: 6, $type: "page_view", $timestamp: daysAgo(95), $detail: "Viewed a house listing" });

  // Grace: qualified and ready for a viewing proposal.
  insertInteraction.run({ $lead_id: 7, $type: "reply", $timestamp: daysAgo(9), $detail: "Yes I would like to see a couple of properties" });

  // Henry: canceled, but with a fresh, qualifying inquiry -- valid reactivation evidence exists.
  insertInteraction.run({ $lead_id: 8, $type: "inquiry", $timestamp: daysAgo(3), $detail: "Actually, is the downtown condo deal still on the table?" });

  const insertProperty = db.prepare(`
    INSERT INTO properties (id, address, area, type, price, bedrooms, tier)
    VALUES ($id, $address, $area, $type, $price, $bedrooms, $tier)
  `);

  insertProperty.run({ $id: 1, $address: "123 Maple St", $area: "Suburbia", $type: "house", $price: 480000, $bedrooms: 3, $tier: "standard" });
  insertProperty.run({ $id: 2, $address: "45 Oak Ave", $area: "Downtown", $type: "condo", $price: 310000, $bedrooms: 2, $tier: "standard" });
  insertProperty.run({ $id: 3, $address: "9 Birch Ln", $area: "Suburbia", $type: "house", $price: 615000, $bedrooms: 4, $tier: "standard" });
  insertProperty.run({ $id: 4, $address: "200 Park Tower", $area: "Downtown", $type: "penthouse", $price: 1450000, $bedrooms: 3, $tier: "upgrade" });
  insertProperty.run({ $id: 5, $address: "78 Lakeview Dr", $area: "Lakeside", $type: "house", $price: 980000, $bedrooms: 5, $tier: "upgrade" });
  insertProperty.run({ $id: 6, $address: "12 Elm Ct", $area: "Downtown", $type: "condo", $price: 265000, $bedrooms: 1, $tier: "standard" });

  const insertHistory = db.prepare(`
    INSERT INTO property_price_history (property_id, year, avg_price)
    VALUES ($property_id, $year, $avg_price)
  `);

  const histories: Record<number, number[]> = {
    1: [430000, 445000, 462000, 480000],
    2: [275000, 288000, 299000, 310000],
    3: [560000, 578000, 595000, 615000],
    4: [1200000, 1290000, 1370000, 1450000],
    5: [820000, 870000, 925000, 980000],
    6: [240000, 248000, 256000, 265000],
  };
  for (const [propertyId, prices] of Object.entries(histories)) {
    prices.forEach((price, i) => {
      insertHistory.run({
        $property_id: Number(propertyId),
        $year: CURRENT_YEAR - (prices.length - 1 - i),
        $avg_price: price,
      });
    });
  }
}

function main() {
  const db = getDb(DEFAULT_DB_PATH);
  seedDatabase(db);
  console.log(`Seeded database at ${DEFAULT_DB_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

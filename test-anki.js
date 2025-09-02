#!/usr/bin/env node

import { YankiConnect } from "yanki-connect";

const client = new YankiConnect();

async function testAnkiConnection() {
  try {
    console.log("Testing Anki connection...");
    
    // Test getting deck names
    const decks = await client.deck.deckNames();
    console.log("Available decks:", decks);
    
    // Test getting due cards
    const dueCards = await client.card.findCards({ query: "is:due" });
    console.log("Due cards count:", dueCards.length);
    
    // Test getting new cards
    const newCards = await client.card.findCards({ query: "is:new" });
    console.log("New cards count:", newCards.length);
    
  } catch (error) {
    console.error("Error connecting to Anki:", error);
  }
}

testAnkiConnection(); 
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import winston from "winston";

import { YankiConnect } from "yanki-connect";

const logFileName = `anki-mcp-server-${new Date().toISOString().split('T')[0]}.log`;
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'anki-mcp-server' },
  transports: [
    new winston.transports.File({ filename: logFileName })
    // Removed console transport to avoid interfering with MCP stdio communication
  ]
});

const client = new YankiConnect();

interface Card {
  cardId: number;
  question: string;
  answer: string;
  due: number;
}

/**
 * Create an MCP server with capabilities for resources (to get Anki cards),
 * and tools (to answer cards, create new cards and get cards).
 */
const server = new Server(
  {
    name: "anki-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

logger.info('Anki MCP Server initialized', { version: '1.0.0' });

/**
 * Handler for listing Anki cards as resources.
 * Cards are exposed as a resource with:
 * - An anki:// URI scheme plus a filter
 * - JSON MIME type
 * - All resources return a list of cards under different filters
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  logger.info('ListResources request received');
  
  const resources = [
    {
      uri: "anki://search/deckcurrent",
      mimeType: "application/json",
      name: "Current Deck",
      description: "Current Anki deck"
    },
    {
      uri: "anki://search/isdue",
      mimeType: "application/json",
      name: "Due cards",
      description: "Cards in review and learning waiting to be studied"
    },
    {
      uri: "anki://search/isnew",
      mimiType: "application/json",
      name: "New cards",
      description: "All unseen cards"
    }
  ];

  logger.info('ListResources response sent', { resourceCount: resources.length });
  return { resources };
});

/**
 * Filters Anki cards based on selected resource
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  logger.info('ReadResource request received', { uri: request.params.uri });
  
  const url = new URL(request.params.uri);
  const query = url.pathname.split("/").pop();
  if (!query) {
    logger.error('Invalid resource URI', { uri: request.params.uri });
    throw new Error("Invalid resource URI");
  }

  try {
    const cards = await findCardsAndOrder(query);
    logger.info('ReadResource response sent', { 
      uri: request.params.uri, 
      query, 
      cardCount: cards.length 
    });

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(cards)
      }]
    };
  } catch (error) {
    logger.error('Error in ReadResource handler', { 
      uri: request.params.uri, 
      query, 
      error: error instanceof Error ? error.message : String(error) 
    });
    throw error;
  }
});

// Returns a list of cards ordered by due date
async function findCardsAndOrder(query: string): Promise<Card[]> {
  logger.debug('Finding cards with query', { query });
  
  const cardIds = await client.card.findCards({
    query: formatQuery(query)
  });
  
  logger.debug('Found card IDs', { cardIdsCount: cardIds.length });
  
  const cards: Card[] = (await client.card.cardsInfo({ cards: cardIds })).map(card => ({
    cardId: card.cardId,
    question: cleanWithRegex(card.question),
    answer: cleanWithRegex(card.answer),
    due: card.due
  })).sort((a: Card, b: Card) => a.due - b.due);

  logger.debug('Processed cards', { 
    query, 
    cardCount: cards.length,
    firstCardId: cards[0]?.cardId,
    lastCardId: cards[cards.length - 1]?.cardId
  });

  return cards;
}

// Formats the uri to be a proper query
function formatQuery(query: string): string {
  const formattedQuery = (() => {
    if (query.startsWith("deck")) {
      return `deck:${query.slice(4)}`;
    }
    if (query === "due") {
      return "is:due";
    }
    if (query === "new") {
      return "is:new";
    }
    if (query.startsWith("is")) {
      return `is:${query.slice(2)}`;
    }
    return query;
  })();
  
  logger.debug('Formatted query', { original: query, formatted: formattedQuery });
  return formattedQuery;
}

// Strip away formatting that isn't necessary
function cleanWithRegex(htmlString: string): string {
  const cleaned = htmlString
    // Remove style tags and their content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Replace divs with newlines
    .replace(/<div[^>]*>/g, '\n')
    // Remove all HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Remove anki play tags
    .replace(/\[anki:play:[^\]]+\]/g, '')
    // Convert HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Clean up whitespace but preserve newlines
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');

  logger.debug('Cleaned HTML string', { 
    originalLength: htmlString.length, 
    cleanedLength: cleaned.length 
  });
  
  return cleaned;
}

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.info('ListTools request received');
  
  const tools = [
    {
      name: "update_cards",
      description: "After the user answers cards you've quizzed them on, use this tool to mark them answered and update their ease",
      inputSchema: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cardId: {
                  type: "number",
                  description: "Id of the card to answer"
                },
                ease: {
                  type: "number",
                  description: "Ease of the card between 1 (Again) and 4 (Easy)"
                }
              }
            }
          }
        },
      }
    },
    {
      name: "add_card",
      description: "Create a new flashcard in Anki for the user. Must use HTML formatting only. IMPORTANT FORMATTING RULES:\n1. Must use HTML tags for ALL formatting - NO markdown\n2. Use <br> for ALL line breaks\n3. For code blocks, use <pre> with inline CSS styling\n4. Example formatting:\n   - Line breaks: <br>\n   - Code: <pre style=\"background-color: transparent; padding: 10px; border-radius: 5px;\">\n   - Lists: <ol> and <li> tags\n   - Bold: <strong>\n   - Italic: <em>",
      inputSchema: {
        type: "object",
        properties: {
          front: {
            type: "string",
            description: "The front of the card. Must use HTML formatting only."
          },
          back: {
            type: "string",
            description: "The back of the card. Must use HTML formatting only."
          }
        },
        required: ["front", "back"]
      }
    },
    {
      name: "get_due_cards",
      description: "Returns a given number (num) of cards due for review.",
      inputSchema: {
        type: "object",
        properties: {
          num: {
            type: "number",
            description: "Number of due cards to get"
          }
        },
        required: ["num"]
      },
    },
    {
      name: "get_new_cards",
      description: "Returns a given number (num) of new and unseen cards.",
      inputSchema: {
        type: "object",
        properties: {
          num: {
            type: "number",
            description: "Number of new cards to get"
          }
        },
        required: ["num"]
      },
    },
    {
      name: "get_all_decks",
      description: "Returns a list of all decks in Anki.",
      inputSchema: {
        type: "object",
        properties: {},
      }
    },
    // Card Actions
    {
      name: "suspend_cards",
      description: "Suspend cards by ID",
      inputSchema: {
        type: "object",
        properties: {
          cards: { type: "array", items: { type: "number" } }
        },
        required: ["cards"]
      }
    },
    {
      name: "get_card_info",
      description: "Get detailed info about cards",
      inputSchema: {
        type: "object",
        properties: {
          cards: { type: "array", items: { type: "number" } }
        },
        required: ["cards"]
      }
    },
    // Deck Actions
    {
      name: "create_deck",
      description: "Create a new deck",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      }
    },
    {
      name: "delete_decks",
      description: "Delete decks",
      inputSchema: {
        type: "object",
        properties: {
          decks: { type: "array", items: { type: "string" } },
          cardsToo: { type: "boolean", default: false }
        },
        required: ["decks"]
      }
    },
    // Note Actions
    {
      name: "update_note",
      description: "Update note fields",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number" },
          fields: { 
            type: "object",
            additionalProperties: { type: "string" }
          }
        },
        required: ["id", "fields"]
      }
    }
  ];

  logger.info('ListTools response sent', { toolCount: tools.length });
  return { tools };
});

/**
 * Handler for the update_cards, add_card, get_due_cards and get_new_cards tools.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  logger.info('CallTool request received', { 
    toolName: name, 
    hasArguments: !!args 
  });

  if (!args) {
    logger.error('No arguments provided for tool', { toolName: name });
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  try {
    switch (name) {
      case "update_cards": {
        const answers = args.answers as { cardId: number; ease: number }[];
        logger.info('Updating cards', { 
          cardCount: answers.length,
          cardIds: answers.map(a => a.cardId)
        });

        const result = await client.card.answerCards({ answers: answers });

        const successfulCards = answers
          .filter((_, index) => result[index])
          .map(card => card.cardId);
        const failedCards = answers.filter((_, index) => !result[index]);

        if (failedCards.length > 0) {
          const failedCardIds = failedCards.map(card => card.cardId);
          logger.error('Failed to update some cards', { 
            failedCardIds, 
            successfulCardIds: successfulCards 
          });
          throw new Error(`Failed to update cards with IDs: ${failedCardIds.join(', ')}`);
        }

        logger.info('Successfully updated cards', { 
          successfulCardIds: successfulCards 
        });

        return {
          content: [{
            type: "text",
            text: `Updated cards ${successfulCards.join(", ")}`
          }]
        };
      }

      case "add_card": {
        const front = String(args.front);
        const back = String(args.back);

        logger.info('Adding new card', { 
          frontLength: front.length, 
          backLength: back.length 
        });

        const note = {
          note: {
            deckName: 'Default',
            fields: {
              Back: back,
              Front: front,
            },
            modelName: 'Basic',
          },
        };

        const noteId = await client.note.addNote(note);
        const cardId = (await client.card.findCards({ query: `nid:${noteId}` }))[0];

        logger.info('Successfully created card', { noteId, cardId });

        return {
          content: [{
            type: "text",
            text: `Created card with id ${cardId}`
          }]
        };
      }

      case "get_due_cards": {
        const num = Number(args.num);
        logger.info('Getting due cards', { requestedCount: num });

        const cardIds = await client.card.findCards({ query: "is:due" });
        const cards = (await client.card.cardsInfo({ cards: cardIds })).map(card => ({
          cardId: card.cardId,
          question: cleanWithRegex(card.question),
          answer: cleanWithRegex(card.answer),
          due: card.due
        })).sort((a, b) => a.due - b.due);

        const returnedCards = cards.slice(0, num);
        logger.info('Retrieved due cards', { 
          totalDue: cards.length, 
          returned: returnedCards.length,
          cardIds: returnedCards.map(c => c.cardId)
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(returnedCards)
          }]
        };
      }

      case "get_new_cards": {
        const num = Number(args.num);
        logger.info('Getting new cards', { requestedCount: num });

        const cardIds = await client.card.findCards({ query: "is:new" });
        const cards = (await client.card.cardsInfo({ cards: cardIds })).map(card => ({
          cardId: card.cardId,
          question: cleanWithRegex(card.question),
          answer: cleanWithRegex(card.answer),
          due: card.due
        })).sort((a, b) => a.due - b.due);

        const returnedCards = cards.slice(0, num);
        logger.info('Retrieved new cards', { 
          totalNew: cards.length, 
          returned: returnedCards.length,
          cardIds: returnedCards.map(c => c.cardId)
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(returnedCards)
          }]
        };
      }

      case "get_all_decks": {
        logger.info('Getting all decks');
        
        try {
          const decks = await client.deck.deckNames();
          logger.info('Retrieved decks', { 
            deckCount: decks.length,
            deckNames: decks 
          });
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify(decks)
            }]
          };
        } catch (error) {
          logger.error('Failed to get decks', { 
            error: error instanceof Error ? error.message : String(error) 
          });
          throw new Error(`Failed to get decks: ${error}`);
        }
      }

      // Card Actions
      case "suspend_cards": {
        const suspended = await client.card.suspend({ cards: args.cards });
        return { 
          content: [{ 
            type: "text", 
            text: `Suspended ${suspended.length} cards` 
          }]
        };
      }

      case "get_card_info": {
        const cardInfo = await client.card.cardsInfo({ cards: args.cards });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(cardInfo)
          }]
        };
      }

      // Deck Actions
      case "create_deck": {
        const deckId = await client.deck.createDeck({ deck: args.name });
        return {
          content: [{
            type: "text",
            text: `Created deck with ID: ${deckId}`
          }]
        };
      }

      case "delete_decks": {
        await client.deck.deleteDecks({
          decks: args.decks,
          cardsToo: args.cardsToo || false
        });
        return {
          content: [{
            type: "text",
            text: `Deleted ${args.decks.length} decks`
          }]
        };
      }

      // Note Actions
      case "update_note": {
        await client.note.updateNoteFields({
          note: {
            id: args.id,
            fields: args.fields
          }
        });
        return {
          content: [{
            type: "text",
            text: `Updated note ${args.id}`
          }]
        };
      }

      default:
        logger.error('Unknown tool requested', { toolName: name });
        throw new Error("Unknown tool");
    }
  } catch (error) {
    logger.error('Error in CallTool handler', { 
      toolName: name, 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  logger.info('Starting Anki MCP Server');
  
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Anki MCP Server started successfully');
  } catch (error) {
    logger.error('Failed to start server', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}

main().catch((error) => {
  logger.error('Server error', { 
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  console.error("Server error:", error);
  process.exit(1);
});

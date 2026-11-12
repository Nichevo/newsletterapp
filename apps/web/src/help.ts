/**
 * The notes behind each "?" in Settings. Each says what the setting does, its
 * usual value and the trade-off; `fixed` names any limit behind it that isn't a
 * setting. Keep them short: two to four sentences.
 */
export interface HelpEntry {
  title: string;
  text: string[];
  fixed?: string;
}

const h = (title: string, text: string[], fixed?: string): HelpEntry => ({ title, text, ...(fixed ? { fixed } : {}) });

export const HELP = {
  // ---------- Settings > Reading (this device only) ----------
  textSize: h('Text size', [
    'How big article text is in the reader. Lists and menus stay the same size.',
    'Saved on this device only, so the phone and the PC can differ.',
  ]),
  inboxView: h('Inbox view', [
    'Compact shows one line per item, Card adds a short preview, Expanded shows the whole AI summary in the list so you can read without opening.',
    'Usual: Card. The icon at the top of the inbox cycles through them. Saved on this device only.',
  ]),
  cardView: h('Card view', [
    'What a Card row shows: how many preview lines (from the summary, or the start of the text) and whether tags and the category show under it.',
  ]),
  expandedView: h('Expanded view', [
    'What an Expanded row shows. Off for "Whole summary" cuts it to 4 lines. Key points and "why it matters" only appear once the PC has summarised the item.',
  ]),
  inboxKeys: h('Key sentences in the lists', [
    'Shows the coloured key sentences under each row in Card and Expanded view, so you can skim without opening.',
    'Colours picks which kinds show; How many picks how many per item.',
  ], 'All shows up to 200 per item; a note says when some are left out.'),
  swipe: h('Swipe to mark read', [
    'Which way you swipe a row to mark it read. The other way saves it for later.',
    'Usual: right. Saved on this device only.',
  ], 'A swipe counts after about 90 pixels of travel.'),
  openIn: h('Live page for Reddit and YouTube', [
    'When you open the live page of a Reddit or YouTube post on an Android phone, whether it opens in their app or in the browser.',
    'If the app is not installed, the browser opens it anyway.',
  ]),
  notesPlace: h('AI notes card', [
    'Where answers to your highlight questions show in an article: at the top, or at the bottom with a small "notes ↓" tag at the top.',
    'Tapping a highlight jumps to its note either way.',
  ]),
  hideSponsored: h('Hide sponsored sections', [
    'Folds away blocks that look like sponsor messages in newsletters, with a note saying how many and a tap to show them.',
    'Saved on this device only.',
  ], 'A block over about 1,500 characters is never treated as sponsored.'),
  readingTime: h('Reading time', [
    'The minutes shown on each item assume 230 words a minute. An article counts as finished in Reading statistics once you have scrolled 70% of it.',
  ]),

  // ---------- Settings > Stories ----------
  storyGroup: h('Same news as one inbox row', [
    'When several sources cover the same news within 2 days, the inbox shows them as one row with the others folded under it.',
    'Off: every article gets its own row, though it still joins its story.',
  ]),
  storyNotes: h('What each new article adds', [
    'Your PC writes one short line saying what a new article adds to its story, shown on the story banner.',
    'Only for articles from the last 14 days, so turning it on never queues thousands of old ones.',
  ]),
  storyAuto: h('Summarise every story automatically', [
    'Your PC writes a summary of the whole story when it forms and again each time an article joins.',
    'Usual: off, as it keeps the PC busier. You can still ask for one on any story page, or switch it off for one story.',
  ]),
  storyCategories: h('Stories by category', [
    'Normal uses the matching level from Statistics > Stories. Stricter needs a closer match and a shared specific tag, which suits comics or anything whose titles look alike. Off keeps a category out of stories.',
    'A change applies to new articles; you are asked whether to rematch the old ones.',
  ], 'Articles join a story when they are up to 30 days apart. A story page shows up to 300 articles.'),

  // ---------- Settings > Daily digest ----------
  digestOn: h('Build a daily digest', [
    'Once a day the app groups the top stories Techmeme style: a lead item with "More:" links to related issues. It uses the summaries and your reading habits; nothing extra goes to the AI.',
    'Off hides the Digest tab. Earlier digests are kept.',
  ]),
  digestWhen: h('Build at and time zone', [
    'The hour the digest is put together, in the time zone you pick. The same time zone sets where a day starts in Reading statistics.',
  ]),
  digestStories: h('Lead stories', [
    'Roughly how many lead stories the digest has. Usual: 12.',
  ], 'Each lead story gets at most 4 "More:" links.'),
  digestWindow: h('Covers', [
    'How much mail the digest looks at: everything since the last digest, or the last 24 or 48 hours.',
  ], 'A digest never covers less than 6 hours, even when built twice in a day.'),
  digestGroup: h('Group by', ['Whether the digest sections are your categories or the newsletters themselves.']),
  digestRead: h('Include issues you have already read', [
    'Off: anything you have read before the digest is built is left out, so it only shows what you missed.',
  ]),
  digestSponsored: h('Include sponsored-heavy issues', [
    'Off: issues the AI flagged as mostly advertising are left out.',
  ]),
  digestDone: h('Done marks stories read', [
    'Whether tapping Done on a digest also marks its stories read in the inbox. You can change it on each digest before tapping Done.',
  ]),
  digestSkip: h('Leave out categories', ['Struck-through categories never appear in the digest. Their items stay in the inbox as usual.']),

  // ---------- Your sources > Categories ----------
  categories: h('Categories', [
    'Your own list of categories. Each source has a usual category (set on its page); keyword rules can override it for one item; otherwise the AI suggests one.',
  ]),
  keywordRules: h('Keyword rules', [
    'When an item’s subject or preview line contains any of the words, it gets that category, whatever its source’s usual one. Separate words with commas.',
    'Rules apply to new items as they arrive.',
  ]),

  // ---------- PC helper and AI ----------
  aiByKind: h('AI summaries by type', [
    'Which types of item go to the AI on your PC. Usual: newsletters on, feeds and websites off, since feeds can be busy.',
    'Switching a type on does new items only; a source’s own page can go back further or override this. Everything gets the free quick summary either way.',
  ], 'The AI reads the first 24,000 characters (about 4,000 words) of an item. Each item gets 3 tries; after 5 failures in a row the AI pauses itself.'),
  aiOffCategories: h('Categories without AI', [
    'Items in a struck-through category skip the AI, for things like comics where a summary adds nothing. A source set to AI On still goes.',
  ]),
  interests: h('Your interests', [
    'A short line about what you care about. The AI uses it for the "why it matters" line in summaries and when answering highlight questions.',
  ]),
  modelsMode: h('Everyday summaries use', [
    'The first model: the top switched-on model does every summary. Split: items are shared between all switched-on models, to compare them or spread the load.',
    'Use Move up and Move down to set the order.',
  ]),
  summaryPrompts: h('Summary prompts', [
    'The instructions the AI follows. The Default prompt is used unless a category or a source has its own; a source’s prompt wins over its category’s.',
    'Changes apply to new summaries only.',
  ]),
  testModels: h('Test models side by side', [
    'Runs the Default prompt on your 20 latest newsletters with up to 3 models, so you can compare them before choosing. Thumbs up or down each answer to keep score.',
    'Test runs count towards usage but are never stopped by the limits.',
  ]),

  // ---------- AI usage and cost ----------
  aiLimits: h('Limits for local AI', [
    'Caps on how many minutes of AI work your PC does per hour, per day and per session. Empty means no limit, which is the usual.',
    'At a limit the PC finishes the item it is on, then waits; items queue up meanwhile.',
  ]),
  aiRest: h('Rest between sessions', [
    'AI work with no gap this long counts as one session. After the session limit, the PC rests this long before carrying on. Usual: 15 minutes.',
  ]),
  aiCost: h('Cost settings', [
    'Used for the running cost estimate only; nothing is limited by it. Electricity is measured from the GPU while it works; wear shares the hardware’s loss in value over the hours it works hard, games included.',
  ]),

  // ---------- Web search ----------
  searchBudget: h('Searches per month', [
    'How many Brave searches the app may use in a calendar month. Set it to your plan’s allowance, less anything else using the same key.',
    'Highlight questions come first: summaries stop searching when less than a tenth is left. When it runs out, answers carry on without searching and say so.',
  ]),
  summarySearch: h('Summaries with web search', [
    'Summaries for the categories or sources you pick also search the headline, adding a "Background" line and "Other coverage" links. One search per summary.',
    'Off everywhere until you switch it on here.',
  ]),

  // ---------- Key sentences ----------
  ksMinWords: h('Articles longer than', [
    'On Auto, only articles at least this long get key sentences. Usual: 1,500 words, about 6 to 7 minutes of reading.',
    'Shorter ones can still be done from the reader.',
  ]),
  ksCategories: h('Key sentences by category', [
    'Auto goes by length; Always does every article; Never skips them. A source’s own setting wins over its category.',
  ]),
  ksBackdate: h('Do older articles too', [
    'Key sentences are only found for articles summarised after you switched them on. These buttons send long articles from the last few days as well.',
  ]),
  ksPerSection: h('Per section', [
    'Roughly how many sentences are marked in each section of an article: Light about 1, Normal about 2, More about 3.',
  ]),
  ksMaxShare: h('At most this much coloured', [
    'A cap on the share of an article’s sentences that get a colour, so long pieces don’t turn into a colouring book. Between 3% and 40%.',
  ], 'At most 400 sentences are kept per article.'),
  ksSkim: h('Open in Skim mode', ['Skim fades everything except the key sentences. You can switch it in the reader either way.']),
  ksIndex: h('Index under long articles', [
    'Lists the people, organisations, places and terms an article names; tap one to jump to each mention. Also feeds the Topics map.',
  ]),
  ksStudies: h('Collect studies and source links', [
    'One short extra step per article that looks only at sentences mentioning a study, report or survey. They collect in Studies, where you can spot the same study quoted differently.',
  ], 'Up to 25 studies and 60 links per article.'),
  ksLinksAll: h('Show links only one article uses', [
    'Off: a source link shows under an article only once another article links to the same page, to keep clutter down.',
  ]),
  ksColours: h('Colours and what they mean', [
    'The five kinds of key sentence. The names and meanings are sent to the model, so changing a meaning changes what it looks for. Switch a kind off to stop marking it.',
  ]),
  ksModel: h('Key sentences model', [
    'Which model finds key sentences. The answer is only sentence numbers and kinds, so a smaller, quicker model often does well. Usual: the same as summaries.',
  ], 'Long articles are sent in pieces of up to 24,000 characters each.'),
  ksExtra: h('Extra instructions', ['Added to the key sentences prompt, for things like "prefer sentences with numbers".']),
  ksRoundups: h('Link roundups', [
    'Lists of links (daily roundups, "what we’re reading") are skipped on Auto. An article counts as one when it has at least this many links per 100 words, or its paragraphs are shorter than this on average.',
  ]),

  // ---------- A source's own page ----------
  srcCategory: h('Category', [
    'The usual category for everything from this source, old and new. A keyword rule can still override it for one item.',
  ]),
  srcAi: h('AI summaries for this source', [
    'Default follows Settings (by type and category). On or Off overrides that for this source only. Switching on lets you go back over older items too, which adds them to the PC’s queue.',
  ]),
  srcKeys: h('Key sentences for this source', [
    'Auto goes by length, Always does every item, Never skips this source (right for link roundups). Wins over the category setting.',
  ]),
  srcCheckEvery: h('Check every', [
    'How often the app looks for new posts. Auto (feeds only) learns when the feed usually posts and checks more often around then, and every 8 hours outside those times.',
    'More often finds posts sooner but uses more of the free Cloudflare allowance.',
  ]),
  srcFetchedBy: h('Fetched by', [
    'Cloudflare checks the feed even when your PC is off. Your PC is for sites that turn Cloudflare away; the app switches by itself after 3 refusals in a row.',
  ], 'Cloudflare checks up to 10 feeds each run; the rest wait for the next run or for the PC.'),
  srcFullText: h('Full articles', [
    'Teasers only: when a feed post is under 150 words, your PC fetches the whole article from the site. Always: every post. Never: keep what the feed gives.',
  ], 'If the PC has not fetched the article within 12 hours, the AI summarises the teaser instead.'),
  srcLinkHint: h('Only links containing', [
    'For website watches: only links whose address contains this text count as new posts, e.g. /blog/ or /comic/. Leave empty to take every article-like link.',
  ], 'Up to 10 new articles are fetched per check, and links dated over 30 days old are skipped.'),
  srcBrowser: h('Needs a browser', [
    'For pages built by JavaScript, which look empty to a plain fetch. Your PC opens them in a hidden Edge or Chrome window. Slower, so only when needed.',
  ]),
  srcPicture: h('Show the picture in the inbox', [
    'For comics and picture feeds: the inbox row shows the post’s main picture, in Expanded view. Your PC picks the strip rather than the site logo.',
  ]),
  srcBundle: h('Group new posts into one item', [
    'For sources that post in bursts: each check’s new posts arrive as one item listing them all, instead of one item each.',
  ]),
  srcFollowLink: h('Fetch the article it links to', [
    'For link sites like Techmeme: the PC fetches the article the post points to, and lists the "More" links as other coverage of the story.',
  ]),
  srcPostFilter: h('Which posts get in', [
    'Only posts mentioning: a post must have one of these words in its title. Skip posts mentioning: posts with any of these are left out. Separate words with commas.',
    'Left-out posts are only remembered as seen. Changes apply to new posts.',
  ], 'Reddit posts come with their top 8 comments.'),
  srcWait: h('Bring new posts in', [
    'Wait until a post is this old before it comes in, so votes and comments build up first. Handy for Reddit. Usual: straight away.',
  ]),
  srcFloodGuard: h('Flood guard', [
    'Past this many new posts in a day, extra posts skip the inbox. Go to Archived keeps them searchable but away from the AI; Bin them drops them for good. Usual: 30 a day.',
  ], 'Each check brings in at most 25 new posts; any more come in with the next check if they are still in the feed.'),
} satisfies Record<string, HelpEntry>;

export type HelpTopic = keyof typeof HELP;

const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

const loggingDir = path.join(__dirname, 'logging');
const logFilePath = path.join(loggingDir, 'log.txt');

if (!fs.existsSync(loggingDir)) {
  fs.mkdirSync(loggingDir, { recursive: true });
}

const accessLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });

const booksPath = path.join(__dirname, 'data', 'books.json');
const reviewsPath = path.join(__dirname, 'data', 'reviews.json');

function safeLoadArray(filePath, arrayKey) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (arrayKey && Array.isArray(payload[arrayKey])) {
      return payload[arrayKey];
    }
    if (Array.isArray(payload)) {
      return payload;
    }
    console.warn(`Expected array at key "${arrayKey}" in ${filePath}, defaulting to empty array.`);
    return [];
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error.message);
    return [];
  }
}

function saveCollection(filePath, arrayKey, items) {
  const payload = arrayKey ? { [arrayKey]: items } : items;
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const books = safeLoadArray(booksPath, 'books');
const reviews = safeLoadArray(reviewsPath, 'reviews');

app.use(express.json());
app.use(morgan('combined', { stream: accessLogStream }));

const allowedApiKeys = new Set(
  (process.env.API_KEYS || 'dev-api-key')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
);

function requireApiKey(req, res, next) {
  if (allowedApiKeys.size === 0) {
    return res.status(500).json({ error: 'No API keys configured.' });
  }

  const providedKey = req.header('x-api-key');
  if (!providedKey || !allowedApiKeys.has(providedKey)) {
    return res.status(401).json({ error: 'Unauthorized: valid API key required.' });
  }

  return next();
}

function generateBookId() {
  const numericIds = books
    .map((book) => Number.parseInt(book.id, 10))
    .filter((value) => Number.isInteger(value));
  const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
  return String(nextId);
}

function generateReviewId() {
  const numericIds = reviews
    .map((review) => {
      if (typeof review.id !== 'string') {
        return undefined;
      }
      const match = review.id.match(/^review-(\d+)$/);
      if (!match) {
        return undefined;
      }
      return Number.parseInt(match[1], 10);
    })
    .filter((value) => Number.isInteger(value));
  const nextId = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
  return `review-${nextId}`;
}

app.get('/api/books', (req, res) => {
  res.json(books);
});

app.get('/api/books/published', (req, res) => {
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'Query parameters "start" and "end" are required (ISO 8601 dates).' });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date format. Use ISO 8601, e.g., 2022-01-01.' });
  }

  if (startDate > endDate) {
    return res.status(400).json({ error: 'Query parameter "start" must be before or equal to "end".' });
  }

  const results = books.filter((book) => {
    const publishedAt = new Date(book.datePublished);
    return !Number.isNaN(publishedAt.getTime()) && publishedAt >= startDate && publishedAt <= endDate;
  });

  res.json(results);
});

app.get('/api/books/top-rated', (req, res) => {
  const topBooks = [...books]
    .sort((a, b) => {
      const aScore = (a.rating ?? 0) * (a.reviewCount ?? 0);
      const bScore = (b.rating ?? 0) * (b.reviewCount ?? 0);
      return bScore - aScore;
    })
    .slice(0, 10);

  res.json(topBooks);
});

app.get('/api/books/featured', (req, res) => {
  res.json(books.filter((book) => book.featured === true));
});

app.get('/api/books/:id/reviews', (req, res) => {
  const { id } = req.params;
  const book = books.find((item) => item.id === id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  res.json(reviews.filter((review) => review.bookId === id));
});

app.get('/api/books/:id', (req, res) => {
  const { id } = req.params;
  const book = books.find((item) => item.id === id);

  if (!book) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  res.json(book);
});

app.post('/api/books', requireApiKey, (req, res) => {
  const requiredFields = ['title', 'author', 'price', 'datePublished'];
  const missingFields = requiredFields.filter((field) => req.body[field] === undefined);
  if (missingFields.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
  }

  const price = Number(req.body.price);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Field "price" must be a positive number.' });
  }

  const datePublished = req.body.datePublished;
  if (Number.isNaN(new Date(datePublished).getTime())) {
    return res.status(400).json({ error: 'Field "datePublished" must be a valid ISO date string.' });
  }

  const rating = req.body.rating !== undefined ? Number(req.body.rating) : 0;
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return res.status(400).json({ error: 'Field "rating" must be between 0 and 5 if provided.' });
  }

  const pages = req.body.pages !== undefined ? Number(req.body.pages) : undefined;
  if (pages !== undefined && (!Number.isInteger(pages) || pages <= 0)) {
    return res.status(400).json({ error: 'Field "pages" must be a positive integer if provided.' });
  }

  const reviewCount = req.body.reviewCount !== undefined ? Number(req.body.reviewCount) : 0;
  if (!Number.isInteger(reviewCount) || reviewCount < 0) {
    return res.status(400).json({ error: 'Field "reviewCount" must be a non-negative integer if provided.' });
  }

  const newBook = {
    id: generateBookId(),
    title: req.body.title,
    author: req.body.author,
    description: req.body.description || '',
    price,
    image: req.body.image || '',
    isbn: req.body.isbn || '',
    genre: Array.isArray(req.body.genre) ? req.body.genre : [],
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    datePublished,
    language: req.body.language || 'English',
    publisher: req.body.publisher || '',
    rating,
    reviewCount,
    inStock: typeof req.body.inStock === 'boolean' ? req.body.inStock : true,
    featured: Boolean(req.body.featured),
  };

  if (pages !== undefined) {
    newBook.pages = pages;
  }

  books.push(newBook);
  saveCollection(booksPath, 'books', books);

  return res.status(201).json(newBook);
});

app.post('/api/reviews', requireApiKey, (req, res) => {
  const requiredFields = ['bookId', 'author', 'rating', 'title', 'comment'];
  const missingFields = requiredFields.filter((field) => req.body[field] === undefined);
  if (missingFields.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
  }

  const book = books.find((item) => item.id === req.body.bookId);
  if (!book) {
    return res.status(404).json({ error: 'Book not found for the provided bookId.' });
  }

  const rating = Number(req.body.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Field "rating" must be between 1 and 5.' });
  }

  const timestamp = req.body.timestamp && !Number.isNaN(new Date(req.body.timestamp).getTime())
    ? new Date(req.body.timestamp).toISOString()
    : new Date().toISOString();

  const newReview = {
    id: generateReviewId(),
    bookId: book.id,
    author: req.body.author,
    rating,
    title: req.body.title,
    comment: req.body.comment,
    timestamp,
    verified: Boolean(req.body.verified),
  };

  reviews.push(newReview);
  book.reviewCount = (book.reviewCount ?? 0) + 1;

  saveCollection(reviewsPath, 'reviews', reviews);
  saveCollection(booksPath, 'books', books);

  return res.status(201).json(newReview);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

app.listen(PORT, () => {
  console.log(`Amana Bookstore API listening on port ${PORT}`);
});

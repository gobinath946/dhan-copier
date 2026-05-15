const HttpError = require('./HttpError');

// Returns an Express middleware that validates req.body against a Zod schema
// and replaces req.body with the parsed (typed/coerced) value.
function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new HttpError(400, 'Validation failed', result.error.flatten()));
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new HttpError(400, 'Validation failed', result.error.flatten()));
    }
    req.validatedQuery = result.data;
    next();
  };
}

module.exports = { validateBody, validateQuery };

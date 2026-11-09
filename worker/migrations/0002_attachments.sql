-- Files attached to a user message: JSON array of {name, type, size, text}. Only the text is kept;
-- it is sent to the model with the message, and in later turns as part of the conversation.
ALTER TABLE messages ADD COLUMN attachments TEXT;

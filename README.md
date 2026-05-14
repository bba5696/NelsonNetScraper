**Logins into your nelson net account and can return your books and book tokens for anyone to use**

```
# Get all books
curl -H "x-api-key: bba" http://localhost:3000/getbooks

# Get link for first book
curl -H "x-api-key: bba" http://localhost:3000/getlink?index=0

# Get link for second book
curl -H "x-api-key: bba" http://localhost:3000/getlink?index=1
```

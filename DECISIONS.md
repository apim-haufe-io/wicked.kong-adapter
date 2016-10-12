# Architectural/Design decisions

## Kong Consumers

Applications in wicked which are used for the OAuth2 Client Credentials flow, or which are using API Keys, will be addede to Kong directly as identifiable `consumers`; they do not carry any information regarding the actual end user calling the API.

Applications which are intended for use with the OAuth2 Implicit Flow will not be added as `consumers` to Kong. Instead, the actual consumer (which here then maps to to the end user person, not machine) will be registered with Kong on demand by calling the `/oauth2/register` end point of this Kong adapter. This is usually done by an implementation of an Authorization Server (which cannot be done generically).

### Idenitification of consumers

Usernames of consumers which were created via the `/oauth2/register` endpoint of the Kong adapter will be prepended with the `oauth2_implicit:` prefix, distinguishing them from the application type consumers (see above).

# Problematic Use Cases

The next section describes things which are problematic for the Kong Adapter and where either a shortcut was made, or where a decision could have gone in different directions. Where possible, a rationale is given for deciding either way.

## Use Case: Synchronizing Consumers

For simplicity, the Kong Adapter only had a single operation, synchronizing all settings. This will not be efficient (never was, but wasn't that bad) if there are very many applications and consumers in the Kong database. The probability of this happening with only API Keys/Client Credentials applications is not that high, but in the case where there are also end users in the calculation, this has potential to change.

As a change now, we will do the following:

* All consumers are only synchronized "left to right", that is from wicked to Kong; any existing consumers in Kong (which do not match a consumer in wicked) are ignored
* Any change on an application only synchronizes that single application, except at first startup, where all consumers are synchronized once (but also only from wicked to Kong)
* New: The Kong Adapter will react to "delete application" events, and subsequently delete those applications from the Kong database

#### Sub-problems (not solved):

* Deleting an application which uses OAuth2 implicit grant from wicked would result in consumers left in the Kong database which could never be cleaned up until Kong is deployed anew (with a fresh database); these consumers could potentially carry still-valid access tokens for an API, even if the application does no longer exist (mitigation: use short expiry times, e.g. 24h or shorter).
* Deleting API Key/CC applications while the Kong adapter is experiencing a down-time could potentially result in applications left in the Kong consumer database, with potentially still valid API Keys/credentials (mitigation: Don't automatically unregister the Kong Adapter if it goes down, but store the events. **done**)

## Use Case: Changing an Application's `redirect_uri`

Actually, this does not seem to be a problem when thinking about it:

* A consumer was created with the application carrying the old redirect_uri
* The redirect_uri has changed, the application ID has not, and this is used as the `name` of the OAuth2 Application which is registered with the consumer
* If the redirect_uri is differing, it is updated in the Kong consumer (deleted and re-added)

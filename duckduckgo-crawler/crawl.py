import json
import sys
import time
from duckduckgo_search import DDGS
from duckduckgo_search.exceptions import DuckDuckGoSearchException

def search_duckduckgo(query, max_results=10, max_retries=3, initial_delay=1):
    print(f"Searching DuckDuckGo for: {query}", file=sys.stderr)
    delay = initial_delay
    for attempt in range(max_retries):
        try:
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=max_results))
            print(f"Found {len(results)} search results", file=sys.stderr)
            return results
        except DuckDuckGoSearchException as e:
            if "Ratelimit" in str(e) and attempt < max_retries - 1:
                print(f"Rate limit hit. Retrying in {delay} seconds...", file=sys.stderr)
                time.sleep(delay)
                delay *= 2  # Exponential backoff
            else:
                raise

def extract_search_results(data):
    results = []
    for item in data:
        results.append({
            "title": item['title'],
            "link": item['href'],
            "snippet": item['body']
        })
    return results

def crawl(query):
    try:
        data = search_duckduckgo(query)
        search_results = extract_search_results(data)
        return [{"content": json.dumps(result), "metadata": {"sourceURL": result['link']}} for result in search_results[:3]]
    except Exception as e:
        print(f"Error during crawl: {str(e)}", file=sys.stderr)
        return []

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(1)

    query = sys.argv[1]
    json_output = crawl(query)
    
    print(json.dumps(json_output))

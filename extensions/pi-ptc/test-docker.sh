#!/bin/bash
# Test script to verify Docker integration

echo "Testing Docker integration for PTC extension..."
echo ""

# Check Docker is running
if ! docker ps > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Clear any existing pi-ptc containers
echo "Cleaning up any existing pi-ptc containers..."
docker ps -a --filter "name=pi-ptc" --format "{{.ID}}" | xargs -r docker stop
echo ""

echo "To enable Docker mode, you need to set PTC_USE_DOCKER=true"
echo ""
echo "Run pi-coding-agent with:"
echo "  PTC_USE_DOCKER=true pi -e /path/to/pi_PTC/dist"
echo ""
echo "In another terminal, run this command to watch for containers:"
echo "  watch -n 1 'docker ps --filter name=pi-ptc'"
echo ""
echo "You should see containers appear with names like: pi-ptc-xxxxx-xxxxx"
echo ""
echo "Press Enter to start monitoring for containers..."
read

echo "Now monitoring for pi-ptc containers..."
echo ""
while true; do
    containers=$(docker ps --filter "name=pi-ptc" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.RunningFor}}")
    clear
    echo "=== PTC Docker Containers ==="
    echo "Make sure to run: PTC_USE_DOCKER=true pi -e /path/to/dist"
    echo ""
    echo "$containers"
    sleep 1
done

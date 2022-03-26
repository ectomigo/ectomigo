build:
	rm -r ./lib
	cp -r ../core/lib .
	# combine dependencies from core
	jq -s '(.[1].dependencies=(.[1].dependencies * .[0].dependencies))[1]' ../core/package.json package.json > temp.package.json
	mv temp.package.json package.json
	npm i

build-test:
	rm -r ./test
	mkdir ./test
	cp -r ../test/*.sql ../test/migrations ../test/package.json ./test
